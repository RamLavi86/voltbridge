// Chat with an API model (Gemini) over the voltbridge tools. Unlike the Claude Code engine in server.js, the model only gets
// the tools passed in: no shell, no file access. To add a provider, write another object with step() like geminiProvider.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('stopped')); }, { once: true });
});

// ---------- tool declarations ----------
// Gemini rejects objects without properties, so a free-form object (or an array of them) is declared as a string holding JSON,
// and decoded again before the handler runs.
const free = (n) => n.type === 'object' && !Object.keys(n.properties || {}).length;
const json = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
function clean(n) { // JSON schema node -> [schema in Gemini's subset, decode(value)]
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

// ---------- Gemini ----------
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const KEEP = 60; // messages sent to the model; older ones are dropped at a user turn
const BUDGET = 90000; // characters (~25k tokens) of history per request, not counting images; older turns are dropped first
const READ = new Set(['get_sheet', 'get_netlist', 'get_bom', 'list_sheets']);

// Every request resends the whole conversation, so what is sent is trimmed: only the newest copy of a repeated read stays in
// full, only the newest pasted image is attached, and the oldest turns go once the history passes BUDGET.
function contents(messages, imageDir, shots) {
  const from = messages.length > KEEP ? messages.findIndex((m, i) => i >= messages.length - KEEP && m.role === 'user') : 0;
  const msgs = messages.slice(from < 0 ? 0 : from);
  const lastTool = msgs.findLastIndex((m) => m.role === 'tool');
  const lastImg = msgs.findLastIndex((m) => m.role === 'user' && m.images?.length);
  const args = {};
  for (const m of msgs) for (const c of m.calls || []) args[c.id] = JSON.stringify(c.args);
  const latest = new Map(); // a read repeated later with the same arguments makes the earlier result stale
  msgs.forEach((m, i) => { if (m.role === 'tool') for (const r of m.results) if (READ.has(r.name)) latest.set(r.name + args[r.id], i); });
  const out = msgs.map((m, i) => {
    if (m.role === 'user') {
      const parts = [];
      if (i === lastImg) {
        for (const f of m.images) {
          try { parts.push({ inlineData: { mimeType: MIME[path.extname(f)] || 'image/png', data: fs.readFileSync(path.join(imageDir, f)).toString('base64') } }); } catch { /* file gone */ }
        }
      }
      parts.push({ text: (m.ctx || '') + m.text + (m.images?.length && i !== lastImg ? ` [${m.images.length} image(s) were attached here; not shown again]` : '') });
      return { role: 'user', parts };
    }
    if (m.role === 'assistant') {
      const parts = m.raw?.length ? m.raw : [...(m.text ? [{ text: m.text }] : []), ...(m.calls || []).map((c) => ({ functionCall: { name: c.name, args: c.args } }))];
      return { role: 'model', parts: parts.length ? parts : [{ text: '(no reply)' }] };
    }
    const parts = m.results.map((r) => {
      const stale = READ.has(r.name) && latest.get(r.name + args[r.id]) !== i;
      return { functionResponse: { name: r.name, response: r.isError ? { error: r.text } : { result: stale ? '(older result left out: a later identical call has the current one)' : r.text } } };
    });
    if (shots && i === lastTool) for (const r of m.results) for (const s of r.shots || []) parts.push({ inlineData: { mimeType: s.mime, data: s.data } });
    return { role: 'user', parts };
  });
  const size = (c) => JSON.stringify(c.parts.map((p) => (p.inlineData ? 0 : p))).length;
  const turnStart = (c) => c.role === 'user' && !c.parts.some((p) => p.functionResponse);
  let total = out.reduce((a, c) => a + size(c), 0), first = 0;
  while (total > BUDGET) {
    const j = out.findIndex((c, k) => k > first && turnStart(c));
    if (j < 0) break;
    for (let k = first; k < j; k++) total -= size(out[k]);
    first = j;
  }
  return out.slice(first);
}

const plain = (p) => Object.keys(p).length === 1 && typeof p.text === 'string';

export function geminiProvider({ apiKey, model = 'gemini-3.5-flash', baseUrl = 'https://generativelanguage.googleapis.com' }) {
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  let shots = true; // some models refuse images inside a tool turn: then we fall back to text only

  async function post(body, signal) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) });
      if (res.ok) return res;
      const j = await res.json().catch(() => ({}));
      const err = j.error?.message;
      if ([429, 500, 503].includes(res.status) && attempt < 2) {
        // a 429 says how long to wait ("retryDelay": "23s"); per-minute limits need that, not 2 seconds
        const asked = parseFloat(j.error?.details?.find((d) => d.retryDelay)?.retryDelay) || 0;
        await sleep(Math.min(Math.max(asked + 1, 2 * (attempt + 1)), 30) * 1000, signal);
        continue;
      }
      const e = new Error(res.status === 429 ? 'Gemini is rate limiting this server (the free tier is shared by all users). Try again in a minute.'
        : res.status === 401 || res.status === 403 || /API key/i.test(err || '') ? 'The Gemini API key was rejected. Check GEMINI_API_KEY.'
        : `Gemini error ${res.status}: ${String(err || res.statusText).slice(0, 300)}`);
      e.status = res.status;
      throw e;
    }
  }

  return {
    name: 'gemini',
    model,
    async step({ system, messages, tools, signal, onText, imageDir }) {
      const body = (withShots) => ({
        systemInstruction: { parts: [{ text: system }] },
        contents: contents(messages, imageDir, withShots),
        tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, ...(t.parameters ? { parameters: t.parameters } : {}) })) }],
      });
      let res;
      try { res = await post(body(shots), signal); } catch (e) {
        const sentShots = shots && messages.some((m) => m.role === 'tool' && m.results.some((r) => r.shots?.length));
        if (e.status !== 400 || !sentShots) throw e;
        shots = false;
        res = await post(body(false), signal);
      }
      const out = { text: '', calls: [], raw: [], usage: null };
      let finish = '';
      const handle = (chunk) => {
        if (chunk.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request (${chunk.promptFeedback.blockReason}).`);
        if (chunk.usageMetadata) out.usage = { prompt: chunk.usageMetadata.promptTokenCount, output: chunk.usageMetadata.candidatesTokenCount };
        const cand = chunk.candidates?.[0];
        if (!cand) return;
        finish = cand.finishReason || finish;
        for (const p of cand.content?.parts || []) {
          const last = out.raw.at(-1);
          if (plain(p) && last && plain(last)) last.text += p.text; else out.raw.push({ ...p });
          if (p.thought) continue;
          if (typeof p.text === 'string' && p.text) { out.text += p.text; onText?.(p.text); }
          if (p.functionCall) out.calls.push({ id: `c${messages.length}-${out.calls.length}`, name: p.functionCall.name, args: p.functionCall.args || {} });
        }
      };
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
          if (data) handle(JSON.parse(data));
        }
      }
      if (!out.text && !out.calls.length && /SAFETY|RECITATION|PROHIBITED|BLOCKLIST/.test(finish)) throw new Error(`Gemini stopped without an answer (${finish}). Rephrase and try again.`);
      return out;
    },
  };
}
