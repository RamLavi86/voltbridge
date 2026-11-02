// Chat with an API model (OpenRouter) over the voltbridge tools. Unlike the Claude Code engine in server.js, the model only gets
// the tools passed in: no shell, no file access. To add a provider, write another object with step() like openaiProvider.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('stopped')); }, { once: true });
});

// ---------- tool declarations ----------
// Some providers reject objects without properties, so a free-form object (or an array of them) is declared as a string holding JSON,
// and decoded again before the handler runs.
const free = (n) => n.type === 'object' && !Object.keys(n.properties || {}).length;
const json = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
function clean(n) { // JSON schema node -> [schema without free-form objects, decode(value)]
  if (!n.type) return [{ type: 'string', description: `${n.description || ''} (any JSON value, JSON-encoded)`.trim() }, json];
  if (free(n)) return [{ type: 'string', description: `${n.description || ''} (a JSON-encoded object)`.trim() }, json];
  if (n.type === 'array' && n.items && (free(n.items) || !n.items.type)) {
    return [{ type: 'string', description: `${n.description || ''} (a JSON-encoded array of objects)`.trim() }, json];
  }
  const out = { type: n.type };
  if (n.description) out.description = n.description;
  if (n.enum) out.enum = n.enum;
  let decode = (v) => v;
  if (n.type === 'array' && n.items) {
    const [items, dec] = clean(n.items);
    out.items = items;
    decode = (v) => (Array.isArray(v) ? v.map(dec) : v);
  } else if (n.type === 'object') {
    out.properties = {};
    const decs = {};
    for (const [k, v] of Object.entries(n.properties)) [out.properties[k], decs[k]] = clean(v);
    if (n.required?.length) out.required = n.required;
    decode = (v) => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decs[k] ? decs[k](x) : x])) : v);
  }
  return [out, decode];
}

// lib.toolDefs() -> [{name, description, parameters?, decode, handler}]
export function apiTools(defs) {
  return defs.map((d) => {
    const js = z.toJSONSchema(z.object(d.shape), { io: 'input' });
    const [schema, decode] = free(js) ? [undefined, (v) => v] : clean(js); // no arguments: declare no parameters
    return { name: d.name, description: d.description, parameters: schema, decode, handler: d.handler };
  });
}

// An MCP-style tool result ({content:[text|image], isError}) -> what the loop stores.
const adapt = (r) => ({
  text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || (r.isError ? 'error' : 'ok'),
  shots: r.content.filter((c) => c.type === 'image').map((c) => ({ mime: c.mimeType, data: c.data })),
  isError: !!r.isError,
});

// ---------- the loop ----------
// messages (mutated, persisted by the caller): {role:'user', text, ctx?, images?: [file]} | {role:'assistant', text, calls, raw?}
// | {role:'tool', results: [{id, name, text, isError, shots?}]}. shots (tool images) are kept in memory only.
export async function runAgent({ provider, system, messages, tools, signal, onText, onTool, onToolDone, onMessage, imageDir, maxSteps = 25 }) {
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  const usage = { prompt: 0, output: 0 };
  for (let step = 0; step < maxSteps; step++) {
    const r = await provider.step({ system, messages, tools, signal, onText, imageDir });
    usage.prompt += r.usage?.prompt || 0;
    usage.output += r.usage?.output || 0;
    if (r.usage?.cost != null) usage.cost = (usage.cost || 0) + r.usage.cost; // credits spent, when the provider reports it
    messages.push({ role: 'assistant', text: r.text, calls: r.calls, raw: r.raw });
    onMessage?.();
    if (!r.calls.length) return usage;
    const results = [];
    for (const c of r.calls) {
      let res;
      if (signal?.aborted) res = { text: 'cancelled by the user', isError: true, shots: [] };
      else {
        onTool?.(c);
        const t = by[c.name];
        try {
          if (!t) throw new Error(`no tool called ${c.name}`);
          res = adapt(await t.handler(t.decode(c.args), {}));
        } catch (e) { res = { text: String(e.message || e), isError: true, shots: [] }; }
        onToolDone?.(c, res);
      }
      results.push({ id: c.id, name: c.name, text: res.text, isError: res.isError, shots: res.shots });
    }
    messages.push({ role: 'tool', results });
    onMessage?.();
    if (signal?.aborted) throw new Error('stopped');
  }
  throw new Error(`Stopped after ${maxSteps} steps without finishing. Ask again to continue.`);
}

// ---------- history trimming and streaming, shared by providers ----------
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const KEEP = 60; // messages sent to the model; older ones are dropped at a user turn
const BUDGET = 90000; // characters (~25k tokens) of history per request, not counting images; older turns are dropped first
const READ = new Set(['get_sheet', 'get_netlist', 'get_bom', 'list_sheets']);

// Every request resends the whole conversation, so what is sent is trimmed: only the newest copy of a repeated read stays in
// full, only the newest pasted image is attached, and the oldest turns go once the history passes BUDGET.
const OLD = '(older result left out: a later identical call has the current one)';
const userText = (m, i, lastImg) => (m.ctx || '') + m.text + (m.images?.length && i !== lastImg ? ` [${m.images.length} image(s) were attached here; not shown again]` : '');

// The window of messages to send, and which of them carry the newest image, the newest tool turn, and stale reads.
function view(messages) {
  const from = messages.length > KEEP ? messages.findIndex((m, i) => i >= messages.length - KEEP && m.role === 'user') : 0;
  const msgs = messages.slice(from < 0 ? 0 : from);
  const lastTool = msgs.findLastIndex((m) => m.role === 'tool');
  const lastImg = msgs.findLastIndex((m) => m.role === 'user' && m.images?.length);
  const args = {};
  for (const m of msgs) for (const c of m.calls || []) args[c.id] = JSON.stringify(c.args);
  const latest = new Map(); // a read repeated later with the same arguments makes the earlier result stale
  msgs.forEach((m, i) => { if (m.role === 'tool') for (const r of m.results) if (READ.has(r.name)) latest.set(r.name + args[r.id], i); });
  const stale = (r, i) => READ.has(r.name) && latest.get(r.name + args[r.id]) !== i;
  return { msgs, lastTool, lastImg, stale };
}

// entries: [{size, turn}] in send order (turn: starts a user turn). Returns the index of the first one to keep: the oldest
// turns go while the total is over BUDGET.
function fit(entries) {
  let total = entries.reduce((a, e) => a + e.size, 0), first = 0;
  while (total > BUDGET) {
    const j = entries.findIndex((e, k) => k > first && e.turn);
    if (j < 0) break;
    for (let k = first; k < j; k++) total -= entries[k].size;
    first = j;
  }
  return first;
}

function sse(res, handle) { // calls handle(data) for each data line group of a server-sent-events body
  return (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const ev = buf.slice(0, i);
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
        const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (data) handle(data);
      }
    }
  })();
}

// ---------- OpenAI-style chat completions (OpenRouter, or any server with the same API) ----------
const dataUrl = (mime, b64) => `data:${mime};base64,${b64}`;

function chatMessages(system, messages, imageDir, shots) {
  const { msgs, lastTool, lastImg, stale } = view(messages);
  const parts = []; // [{wire: [message], turn}]
  msgs.forEach((m, i) => {
    if (m.role === 'user') {
      const imgs = [];
      if (i === lastImg) {
        for (const f of m.images) {
          try { imgs.push({ type: 'image_url', image_url: { url: dataUrl(MIME[path.extname(f)] || 'image/png', fs.readFileSync(path.join(imageDir, f)).toString('base64')) } }); } catch { /* file gone */ }
        }
      }
      const text = userText(m, i, lastImg);
      parts.push({ wire: [{ role: 'user', content: imgs.length ? [...imgs, { type: 'text', text }] : text }], turn: true });
    } else if (m.role === 'assistant') {
      const a = { role: 'assistant', content: m.text || (m.calls?.length ? null : '(no reply)') };
      if (m.calls?.length) a.tool_calls = m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      if (m.raw?.reasoning_details?.length) a.reasoning_details = m.raw.reasoning_details; // some providers need the reasoning back with tool results
      parts.push({ wire: [a], turn: false });
    } else {
      const wire = m.results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.isError ? `error: ${r.text}` : stale(r, i) ? OLD : r.text }));
      const pics = shots && i === lastTool ? m.results.flatMap((r) => (r.shots || []).map((s) => ({ type: 'image_url', image_url: { url: dataUrl(s.mime, s.data) } }))) : [];
      // a tool message holds text only, so tool images ride in a user message right after
      if (pics.length) wire.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by the tool call(s) above:' }, ...pics] });
      parts.push({ wire, turn: false });
    }
  });
  const size = (p) => JSON.stringify(p.wire.map((w) => (Array.isArray(w.content) ? { ...w, content: w.content.filter((c) => c.type === 'text') } : w))).length;
  return [{ role: 'system', content: system }, ...parts.slice(fit(parts.map((p) => ({ size: size(p), turn: p.turn })))).flatMap((p) => p.wire)];
}

// reasoning_details arrive in pieces; pieces with the same type and index are one entry whose text grows
function mergeDetail(list, x) {
  const cur = list.find((y) => y.type === x.type && y.index === x.index);
  if (!cur) { list.push({ ...x }); return; }
  for (const [k, v] of Object.entries(x)) cur[k] = (k === 'text' || k === 'summary') && typeof v === 'string' ? (cur[k] || '') + v : v;
}

// Options: model (required), baseUrl, keyVar (named in the "key rejected" message), label, headers, extra (merged into the request
// body, e.g. OpenRouter routing preferences).
export function openaiProvider({ name = 'openai', label = 'The model server', apiKey, model, baseUrl, keyVar = 'the API key', headers = {}, extra = {} }) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  let shots = true; // some models refuse images inside a tool turn: then we fall back to text only

  async function post(body, signal) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...headers }, body: JSON.stringify(body) });
      if (res.ok) return res;
      const j = await res.json().catch(() => ({}));
      const err = j.error?.message || j.message || res.statusText;
      if ([429, 500, 502, 503].includes(res.status) && attempt < 2) {
        const asked = parseFloat(res.headers.get('retry-after')) || 0;
        await sleep(Math.min(Math.max(asked, 2 * (attempt + 1)), 30) * 1000, signal);
        continue;
      }
      const e = new Error(res.status === 401 ? `${label} rejected the API key. Check ${keyVar}.`
        : res.status === 402 ? `${label} says the account is out of credits. Add credits and try again.`
        : res.status === 429 ? `${label} is rate limiting this server. Try again in a minute.`
        : `${label} error ${res.status}: ${String(err).slice(0, 300)}`);
      e.status = res.status;
      throw e;
    }
  }

  return {
    name,
    model,
    async step({ system, messages, tools, signal, onText, imageDir }) {
      const body = (withShots) => ({
        model,
        messages: chatMessages(system, messages, imageDir, withShots),
        tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } } })),
        stream: true,
        ...extra,
      });
      let res;
      try { res = await post(body(shots), signal); } catch (e) {
        const sentShots = shots && messages.some((m) => m.role === 'tool' && m.results.some((r) => r.shots?.length));
        if (e.status !== 400 || !sentShots) throw e;
        shots = false;
        res = await post(body(false), signal);
      }
      const out = { text: '', calls: [], raw: null, usage: null };
      const calls = [], details = [];
      let finish = '';
      await sse(res, (data) => {
        if (data === '[DONE]') return;
        const c = JSON.parse(data);
        if (c.error) throw new Error(`${label} error: ${String(c.error.message || JSON.stringify(c.error)).slice(0, 300)}`);
        if (c.usage) out.usage = { prompt: c.usage.prompt_tokens, output: c.usage.completion_tokens, ...(c.usage.cost != null ? { cost: c.usage.cost } : {}) };
        const ch = c.choices?.[0];
        if (!ch) return;
        finish = ch.finish_reason || finish;
        const d = ch.delta || {};
        if (d.content) { out.text += d.content; onText?.(d.content); }
        for (const x of d.reasoning_details || []) mergeDetail(details, x);
        for (const t of d.tool_calls || []) {
          const cur = (calls[t.index ?? 0] ||= { id: '', name: '', args: '' });
          if (t.id) cur.id = t.id;
          if (t.function?.name && !cur.name) cur.name = t.function.name;
          if (t.function?.arguments) cur.args += t.function.arguments;
        }
      });
      out.calls = calls.filter(Boolean).map((c, i) => {
        let args = {};
        try { args = JSON.parse(c.args || '{}'); } catch { /* cut off or malformed: the tool reports what is missing */ }
        return { id: c.id || `c${messages.length}-${i}`, name: c.name, args };
      });
      if (details.length) out.raw = { reasoning_details: details };
      if (!out.text && !out.calls.length && finish === 'content_filter') throw new Error(`${label} stopped without an answer (content filter). Rephrase and try again.`);
      return out;
    },
  };
}

// OpenRouter: one key, many models. Routing is limited to providers that do not store prompts or train on them
// (dataCollection 'deny'); require_parameters keeps the request on providers that support tools.
export function openrouterProvider({ apiKey, model, baseUrl = 'https://openrouter.ai/api/v1', fallbacks = [], dataCollection = 'deny' }) {
  if (!model) throw new Error('OPENROUTER_MODEL is not set. Pick a model that supports tools at https://openrouter.ai/models?supported_parameters=tools and copy its id.');
  return openaiProvider({
    name: 'openrouter', label: 'OpenRouter', keyVar: 'OPENROUTER_API_KEY', apiKey, model, baseUrl,
    headers: { 'x-title': 'Voltbridge' },
    extra: { usage: { include: true }, provider: { require_parameters: true, data_collection: dataCollection }, ...(fallbacks.length ? { models: [model, ...fallbacks] } : {}) },
  });
}
