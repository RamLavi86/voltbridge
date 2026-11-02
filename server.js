import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import * as lib from './lib.js';
import * as ai from './ai.js';
import { createAuth, costOf } from './auth.js';

// Settings such as OPENROUTER_API_KEY can live in a git-ignored .env next to this file; real environment variables win.
try { process.loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url))); } catch { /* no .env */ }

// The SDK can reject an internal promise after a failed turn; chat() already reported it, so don't let Node die.
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e));

const PORT = +process.env.PORT || 8430;
const HOST = process.env.HOST || '127.0.0.1'; // Claude can write to disk: never default to 0.0.0.0
const ioe = path.join(os.homedir(), 'ioe');
const CWD = process.env.VOLTBRIDGE_CWD || (fs.existsSync(ioe) ? ioe : os.homedir());
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');

// Off loopback, require a token: open /?token=<t> once, it becomes a cookie for the page and the WebSocket.
const LOCAL = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
// Google sign-in through Supabase (auth.js) replaces the shared token when SUPABASE_URL and SUPABASE_SERVICE_KEY are set on a hosted server.
const num = (v, d) => (v != null && v !== '' && Number.isFinite(+v) ? +v : d);
const AUTH = !LOCAL && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createAuth({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY, userCap: num(process.env.USER_MONTHLY_CAP_USD, 0.5), globalCap: num(process.env.GLOBAL_MONTHLY_CAP_USD, 10), open: process.env.OPEN_SIGNUP !== 'false' })
  : null;
const tokenFile = path.join(lib.HOME, 'token');
const TOKEN = LOCAL || AUTH ? null : process.env.VOLTBRIDGE_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim()
  : (fs.mkdirSync(lib.HOME, { recursive: true }), fs.writeFileSync(tokenFile, crypto.randomBytes(18).toString('base64url'), { mode: 0o600 }), fs.readFileSync(tokenFile, 'utf8')));
// Who answers the chat. 'claude' is the Claude Code engine: Bash and file access with no prompts, so local only.
// 'openrouter' calls an API with just the voltbridge tools (ai.js), which is what a hosted server uses.
const PROVIDER = process.env.VOLTBRIDGE_PROVIDER || (LOCAL ? 'claude' : 'openrouter');
const PROVIDERS = { claude: { name: 'Claude' }, openrouter: { name: 'OpenRouter', key: 'OPENROUTER_API_KEY', model: 'OPENROUTER_MODEL' } };
if (!PROVIDERS[PROVIDER]) throw new Error(`VOLTBRIDGE_PROVIDER must be one of ${Object.keys(PROVIDERS).join(', ')}, not "${PROVIDER}"`);
const ASSISTANT = PROVIDERS[PROVIDER].name;
const KEY_VAR = PROVIDERS[PROVIDER].key;
// Off loopback the Claude engine stays off unless VOLTBRIDGE_CHAT=1, and clients can't pick the working or output folders on the server's disk.
const CHAT = LOCAL || PROVIDER !== 'claude' || process.env.VOLTBRIDGE_CHAT === '1';
const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// Who is calling: a user {id, email, root (their sessions folder), cwd} or null. Locally and with the shared token there is one user.
const LOCAL_USER = { id: 'local', email: null, root: lib.SESSIONS, cwd: CWD };
const users = new Map();
const userOf = (req) => {
  if (!AUTH) return !TOKEN || same(/(?:^|;\s*)vb=([^;]+)/.exec(req.headers.cookie || '')?.[1], TOKEN) ? LOCAL_USER : null;
  const u = AUTH.read(req.headers.cookie);
  if (!u || !/^[\w-]{1,64}$/.test(u.id)) return null;
  if (!users.has(u.id)) { const root = path.join(lib.SESSIONS, `u_${u.id}`); fs.mkdirSync(root, { recursive: true }); users.set(u.id, { ...u, root, cwd: root }); }
  return users.get(u.id);
};
// a WebSocket must come from our own pages
const originOk = (req) => !AUTH || !req.headers.origin || new URL(req.headers.origin).host === req.headers.host;
const hits = new Map(); // chats per user in the last minute
const rateOk = (u) => { const t = Date.now(), a = (hits.get(u.id) || []).filter((x) => t - x < 60000); hits.set(u.id, a); if (a.length >= 6) return false; a.push(t); return true; };

// Build the UI when dist is missing or older than anything in web/.
const newest = (d) => Math.max(...fs.readdirSync(d, { withFileTypes: true }).map((e) => (e.isDirectory() ? newest(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).mtimeMs)));
const built = path.join(dist, 'index.html');
if (!fs.existsSync(built) || fs.statSync(built).mtimeMs < Math.max(newest(path.join(here, 'web')), fs.statSync(path.join(here, 'vite.config.js')).mtimeMs)) {
  console.log('building UI...');
  const { build } = await import('vite');
  await build({ configFile: path.join(here, 'vite.config.js'), logLevel: 'warn' });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.map': 'application/json' };
const inside = (root, p) => { const f = path.join(root, path.normalize(p)); return f.startsWith(root + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : null; };
const page = (res, name, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(path.join(here, 'pages', `${name}.html`)).pipe(res); };
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  // public pages (Google's consent screen links to them), served before any login check
  if (p === '/privacy' || p === '/terms') return page(res, p.slice(1));
  const https = (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
  if (AUTH) { // Google sign-in: the browser goes to Supabase, comes back to /auth/callback with a token, which we trade for our own cookie
    if (p === '/auth/google') {
      const back = `${process.env.PUBLIC_URL || `${https ? 'https' : 'http'}://${req.headers.host}`}/auth/callback`;
      res.writeHead(302, { Location: `${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(back)}` });
      return res.end();
    }
    if (p === '/auth/callback') return page(res, 'callback');
    if (req.method === 'POST' && p === '/auth/session') {
      let body = ''; for await (const d of req) { body += d; if (body.length > 20000) return json(res, 413, { error: 'too large' }); }
      try {
        const user = await AUTH.login(JSON.parse(body).access_token);
        return json(res, 200, { ok: true }, { 'Set-Cookie': `vb=${AUTH.sign(user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${https ? '; Secure' : ''}` });
      } catch (e) { return json(res, 401, { error: String(e.message || e) }); }
    }
    if (req.method === 'POST' && p === '/auth/logout') return json(res, 200, { ok: true }, { 'Set-Cookie': `vb=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${https ? '; Secure' : ''}` });
  }
  // a '+' in the query reads as a space, and base64 tokens contain '+'
  if (TOKEN && same(u.searchParams.get('token')?.replaceAll(' ', '+'), TOKEN)) {
    res.writeHead(302, { 'Set-Cookie': `vb=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, Location: '/' });
    return res.end();
  }
  const user = userOf(req);
  if (!user && AUTH && p === '/') return page(res, 'landing');
  if (!user) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end(AUTH ? 'voltbridge: sign in at /' : 'voltbridge: open the link with ?token=... printed in the server terminal'); }
  if (req.method === 'POST' && p === '/client-error') {
    let body = ''; req.on('data', (d) => { body += d; }).on('end', () => { console.error('[browser]', body.slice(0, 4000)); res.end(); });
    return;
  }
  const img = p.match(/^\/img\/([^/]+)\/([^/]+)$/);
  const f = img ? (lib.validName(img[1]) && lib.validName(img[2]) ? inside(path.join(user.root, img[1], 'images'), img[2]) : null) : inside(dist, p) || built;
  if (!f) { res.writeHead(404); return res.end(); }
  const type = MIME[path.extname(f)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': /^text|javascript|json|svg/.test(type) ? `${type}; charset=utf-8` : type });
  fs.createReadStream(f).pipe(res);
});

const PROMPT = `You are running inside voltbridge: a chat beside an electrical schematic editor (IEC 60617 style symbols, sheets with zone frames and title blocks).
Use the voltbridge tools to read and draw: list_sheets, list_symbols, get_sheet, edit_sheet, new_sheet, snapshot, get_netlist, get_bom, export, set_project.
How to draw well:
- Call list_symbols once to learn symbol keys, pin names and pin offsets before placing parts. Everything snaps to a 10px grid; pins are on the grid.
- Control and power circuits read top to bottom: supply rails (or net labels such as L1, L2, L3, N, PE, +24V, 0V) across the top and bottom, current paths as vertical columns 80-120px apart, parts in a column sharing one x so wires are straight.
- Single-line diagrams: draw one line per circuit, use kind:"bus" wires for busbars (with label "L1 L2 L3 N"), and the 1-pole symbols with props.poles ("3", "4", "3P+N") so the pole marking is drawn. Multi-line boards have rcd_4p, rcbo, breaker_4p, switch_disconnector_4p.
- Distribution boards: one board per sheet with its own refPrefix (=MDB1, =SDB2...); frame it with a rect op; give outgoing breakers circuit, cable, length, phase, power props and end each circuit on a load symbol (socket, light, water_heater, cooker, ac_unit, ev_charger, heater, motor); place a table op with auto:"circuits" for the schedule. Use the array op for repeated branch circuits.
- PV in single-line: pv_array, battery_storage and hybrid_inverter have one pin per conductor bundle; pv_module/battery are the two-pin forms for multi-line drawings.
- Leave about 40px between parts in a column and keep ref/value text (drawn to the right of each part) clear of neighbours.
- Prefer connect ops between pins over hand-drawn wires; give via points to route around parts. A wire end that lands on another wire joins it (a junction dot is drawn).
- Use IEC designators: Q breakers/isolators, F fuses/SPDs, K relays/contactors (contacts share the coil's ref), S switches, M motors, T transformers, G sources/PV/batteries, U converters/inverters, X terminals, P meters, H lamps, A devices.
- Put ratings in props.value; partNo, maker and description feed the BOM.
- Issues include text overlaps ("Q5 text ... overlaps Q6"): widen spacing or set props.labelPos "below".
- After a batch, read the issues in the edit_sheet result and take a snapshot to check the drawing; fix overlaps, dangling pins and crossing text before you finish.
When the user pastes an image of a schematic, recreate it as an editable schematic (a new sheet unless told otherwise), keeping refs, values and topology.`;
// Every API request carries the prompt, so the symbol library goes in here once (no list_symbols step) and each user message names the sheets.
const API_PROMPT = `${PROMPT.replace('Call list_symbols once to learn symbol keys, pin names and pin offsets before placing parts.', 'Use the symbol keys, pin names and pin offsets listed below when placing parts.')}
You act only through the voltbridge tools: you have no shell and no file access. Each user message starts with [voltbridge] lines giving the sheets, the sheet the user is looking at and their selection, so you do not need list_sheets or list_symbols: start from get_sheet when you need what is already drawn, and call it again only after you changed the sheet.
If edit_sheet reports errors or issues, fix them and look again before you answer. End with a short summary of what you drew or changed.

Symbol library:
${lib.symbolText()}`;
const DEFAULT_IMAGE_ASK ='Recreate this image as an editable schematic on a new sheet.';

const live = new Map();
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const broadcast = (s, m, except) => s.clients.forEach((ws) => ws !== except && send(ws, m));

const keyOf = (user, name) => `${user.id}/${name}`; // live sessions are per user
function attach(user, name, cwd) {
  if (!live.has(keyOf(user, name))) {
    const fresh = !fs.existsSync(path.join(user.root, name, 'session.json'));
    const s = lib.openSession(name, LOCAL && cwd && fs.existsSync(cwd) ? path.resolve(cwd) : user.cwd, user.root);
    lib.saveSession(s);
    Object.assign(s, { user, clients: new Set(), q: null, timer: null, dirty: new Set() });
    live.set(keyOf(user, name), s);
    if (fresh) allSessions(user);
  }
  return live.get(keyOf(user, name));
}
function touch(s, id) {
  if (id != null) s.dirty.add(id);
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { if (!s.deleted) lib.saveSession(s, [...s.dirty]); s.dirty.clear(); }, 400);
}
const sheetsMsg = (s, goto) => ({ t: 'sheets', sheets: s.sheets, docs: s.docs, project: s.project, goto });
const ctxFor = (s) => ({
  sheetChanged: (doc) => broadcast(s, { t: 'sheet', doc, by: 'claude' }),
  sheetsChanged: (goto) => { broadcast(s, sheetsMsg(s, goto)); allSessions(s.user); },
  exported: (files) => broadcast(s, { t: 'exported', files }),
});

const IMG_LINE = '[voltbridge] pasted images saved as: ';
const imgUrls = (s, line) => line.slice(IMG_LINE.length).split(', ').map((f) => `/img/${encodeURIComponent(s.name)}/${path.basename(f)}`);

async function chat(s, text, images = [], sheetId, selection = []) {
  if (!CHAT) return broadcast(s, { t: 'error', text: 'Chat is turned off on this server. The schematic editor works as usual.' });
  if (s.q || s.checking) return broadcast(s, { t: 'error', text: `${ASSISTANT} is still working; press Stop first.` });
  if (PROVIDER !== 'claude' && !process.env[KEY_VAR]) return broadcast(s, { t: 'error', text: `${KEY_VAR} is not set on the server, so chat cannot run.` });
  if (PROVIDER === 'openrouter' && !process.env.OPENROUTER_MODEL) return broadcast(s, { t: 'error', text: 'OPENROUTER_MODEL is not set on the server, so chat cannot run.' });
  if (AUTH && PROVIDER !== 'claude') { // monthly allowance per user and for the whole server, before any money is spent
    if (!rateOk(s.user)) return broadcast(s, { t: 'error', text: 'Too many requests in a minute. Wait a moment and try again.' });
    s.checking = true;
    try { s.allow = await AUTH.limits(s.user); } finally { s.checking = false; }
    if (!s.allow.ok) return broadcast(s, { t: 'error', text: s.allow.reason });
  }
  const files = images.length ? lib.saveImages(s, images) : [];
  text = text.trim() || (files.length ? DEFAULT_IMAGE_ASK : '');
  if (!text) return;
  let prefix = `[voltbridge] output folder for exports: ${s.outDir}\n`;
  const doc = s.docs[sheetId];
  if (doc) prefix += `[voltbridge] the user is looking at sheet ${doc.id} "${doc.name}"${selection.length ? `, with selected: ${selection.join(', ')}` : ''}\n`;
  broadcast(s, { t: 'user', text, images: files.length ? imgUrls(s, IMG_LINE + files.join(', ')) : [] });
  if (PROVIDER !== 'claude') return chatApi(s, text, `${lib.sheetsSummary(s)}\n${prefix}\n`, files);
  if (files.length) prefix += IMG_LINE + files.map((f) => path.join(s.dir, 'images', f)).join(', ') + '\n';
  const content = [...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } })), { type: 'text', text: `${prefix}\n${text}` }];
  const prompt = files.length ? (async function* () { yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }; })() : content.at(-1).text;
  try {
    s.q = query({
      prompt,
      options: {
        cwd: s.cwd,
        resume: s.claudeSessionId || undefined,
        mcpServers: { voltbridge: lib.makeMcp(s, ctxFor(s)) },
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: PROMPT },
        // ponytail: no approval UI, so Claude runs unattended like `claude --dangerously-skip-permissions`. Bound to localhost for this reason.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        stderr: (d) => process.stderr.write(d),
      },
    });
    for await (const m of s.q) {
      if (m.session_id && m.session_id !== s.claudeSessionId) { s.claudeSessionId = m.session_id; lib.saveSession(s, []); }
      if (m.parent_tool_use_id) continue;
      if (m.type === 'stream_event' && m.event.type === 'content_block_delta' && m.event.delta.type === 'text_delta') broadcast(s, { t: 'delta', text: m.event.delta.text });
      else if (m.type === 'assistant') {
        for (const b of m.message.content) if (b.type === 'tool_use') broadcast(s, { t: 'tool', id: b.id, name: b.name.replace('mcp__voltbridge__', ''), input: JSON.stringify(b.input).slice(0, 200) });
      } else if (m.type === 'user' && Array.isArray(m.message.content)) {
        for (const b of m.message.content) if (b.type === 'tool_result') broadcast(s, { t: 'tool_done', id: b.tool_use_id, error: !!b.is_error });
      } else if (m.type === 'result' && m.subtype !== 'success') broadcast(s, { t: 'error', text: `Claude stopped: ${m.subtype} ${(m.errors || []).join(' ')}` });
    }
  } catch (e) {
    broadcast(s, { t: 'error', text: String(e.message || e) });
  } finally {
    s.q = null;
    broadcast(s, { t: 'done' });
  }
}

// The API path: our own transcript (s.chat, saved as chat.json) and the loop in ai.js.
let apiProvider; // shared, so what it learns about the model (no images in tool turns) lasts
const getProvider = () => (apiProvider ||= ai.openrouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL, baseUrl: process.env.OPENROUTER_BASE_URL || undefined,
  fallbacks: (process.env.OPENROUTER_FALLBACKS || '').split(',').map((x) => x.trim()).filter(Boolean),
  dataCollection: process.env.OPENROUTER_DATA_COLLECTION === 'allow' ? 'allow' : 'deny',
}));
async function chatApi(s, text, ctx, files) {
  const ac = new AbortController();
  s.q = { interrupt: () => ac.abort() };
  const save = () => { if (!s.deleted) lib.saveChat(s); };
  const used = { model: getProvider().model, prompt: 0, output: 0, cost: 0 };
  let overCap = false;
  try {
    s.chat.push({ role: 'user', text, ctx, images: files });
    save();
    const usage = await ai.runAgent({
      provider: getProvider(),
      system: API_PROMPT,
      messages: s.chat,
      tools: ai.apiTools(lib.toolDefs(s, ctxFor(s))),
      signal: ac.signal,
      imageDir: path.join(s.dir, 'images'),
      onText: (t) => broadcast(s, { t: 'delta', text: t }),
      onTool: (c) => broadcast(s, { t: 'tool', id: c.id, name: c.name, input: JSON.stringify(c.args).slice(0, 200) }),
      onToolDone: (c, r) => broadcast(s, { t: 'tool_done', id: c.id, error: r.isError }),
      onMessage: save,
      onUsage: (u) => { // meter every step; stop the run once this user's allowance is used up
        used.prompt += u.prompt || 0; used.output += u.output || 0; used.cost += costOf(u);
        if (s.allow?.ok && s.allow.spent + used.cost >= s.allow.cap && !ac.signal.aborted) { overCap = true; ac.abort(); }
      },
    });
    console.log(`[${s.name}] ${getProvider().model}: ${usage.prompt} tokens in, ${usage.output} out${usage.cost != null ? `, $${usage.cost.toFixed(4)}` : ''}`);
  } catch (e) {
    if (overCap) broadcast(s, { t: 'error', text: `You reached your monthly allowance ($${s.allow.cap.toFixed(2)}), so I stopped here. It resets on the 1st.` });
    else if (!ac.signal.aborted) broadcast(s, { t: 'error', text: String(e.message || e) });
  } finally {
    if (AUTH && (used.prompt || used.output)) await AUTH.record(s.user, used);
    s.q = null;
    broadcast(s, { t: 'done' });
  }
}

async function history(s) {
  if (PROVIDER !== 'claude') {
    return s.chat.flatMap((m) => (m.role === 'user' ? [{ role: 'user', text: m.text, images: (m.images || []).map((f) => `/img/${encodeURIComponent(s.name)}/${f}`) }]
      : m.role === 'assistant' ? [...(m.text ? [{ role: 'assistant', text: m.text }] : []), ...(m.calls || []).map((c) => ({ role: 'tool', name: c.name }))] : []));
  }
  if (!s.claudeSessionId) return [];
  const out = [];
  for (const m of await getSessionMessages(s.claudeSessionId, { dir: s.cwd }).catch(() => [])) {
    if (m.parent_tool_use_id) continue;
    const c = m.message?.content;
    for (const b of typeof c === 'string' ? [{ type: 'text', text: c }] : c || []) {
      if (b.type === 'text' && b.text.trim() && m.type === 'user') {
        const imgs = b.text.split('\n').find((l) => l.startsWith(IMG_LINE));
        out.push({ role: 'user', text: b.text.replace(/^(\[voltbridge\][^\n]*\n)+\n/, ''), images: imgs ? imgUrls(s, imgs) : [] });
      } else if (b.type === 'text' && b.text.trim()) out.push({ role: m.type, text: b.text });
      else if (b.type === 'tool_use') out.push({ role: 'tool', name: b.name.replace('mcp__voltbridge__', '') });
    }
  }
  return out;
}

const sessionsMsg = (user) => ({ t: 'sessions', sessions: lib.listSessions(user.root) });
const allSessions = (user) => { const m = sessionsMsg(user); wss.clients.forEach((c) => c.user?.id === user.id && send(c, m)); }; // only that user's windows
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => !!userOf(req) && originOk(req), maxPayload: 32 * 1024 * 1024 });
wss.on('connection', (ws, req) => {
  let s = null;
  const user = ws.user = userOf(req);
  send(ws, { ...sessionsMsg(user), t: 'hello', cwd: user.cwd, assistant: ASSISTANT, user: user.email });
  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    try {
      if (s?.deleted) s = null;
      if (m.t === 'list') send(ws, sessionsMsg(user));
      else if (m.t === 'open') {
        s?.clients.delete(ws);
        s = attach(user, m.name, m.cwd);
        s.clients.add(ws);
        send(ws, { t: 'session', name: s.name, cwd: s.cwd, outDir: s.outDir, sheets: s.sheets, docs: s.docs, project: s.project, busy: !!s.q, history: await history(s) });
      } else if (m.t === 'renameSession') {
        const t = live.get(keyOf(user, m.from));
        if (t?.q) throw new Error('Claude is working in that session; stop it or wait, then rename.');
        if (t) { clearTimeout(t.timer); lib.saveSession(t); }
        lib.renameSession(m.from, m.to, user.root);
        if (t && m.from !== m.to) { live.delete(keyOf(user, m.from)); Object.assign(t, { name: m.to, dir: path.join(user.root, m.to) }); live.set(keyOf(user, m.to), t); broadcast(t, { t: 'renamed', to: m.to }); }
        allSessions(user);
      } else if (m.t === 'deleteSession') {
        const t = live.get(keyOf(user, m.name));
        if (t?.q) throw new Error('Claude is working in that session; stop it or wait, then delete.');
        if (t) { clearTimeout(t.timer); t.deleted = true; live.delete(keyOf(user, m.name)); }
        lib.deleteSession(m.name, user.root);
        if (t) { for (const c of t.clients) send(c, { t: 'deleted', name: m.name, next: lib.listSessions(user.root)[0]?.name || 'default' }); t.clients.clear(); }
        allSessions(user);
      } else if (!s) return;
      else if (m.t === 'chat') chat(s, m.text || '', m.images || [], m.sheet, m.selection || []).catch((e) => send(ws, { t: 'error', text: String(e.message || e) }));
      else if (m.t === 'stop') s.q?.interrupt();
      else if (m.t === 'sheet') { // the editor's whole sheet after a user edit
        if (lib.putSheet(s, m.doc, m.baseRev)) { touch(s, m.doc.id); send(ws, { t: 'ack', id: m.doc.id, rev: s.docs[m.doc.id].rev }); broadcast(s, { t: 'sheet', doc: s.docs[m.doc.id] }, ws); }
        else send(ws, { t: 'sheet', doc: s.docs[m.doc.id], conflict: true });
      } else if (m.t === 'newSheet') { const d = lib.addSheet(s, m.name, m.size); ctxFor(s).sheetsChanged(d.id); }
      else if (m.t === 'deleteSheet') { lib.removeSheet(s, m.id); ctxFor(s).sheetsChanged(); }
      else if (m.t === 'moveSheet') { // reorder: put sheet id before index
        const i = s.sheets.findIndex((x) => x.id === m.id);
        if (i >= 0) { const [x] = s.sheets.splice(i, 1); s.sheets.splice(Math.max(0, Math.min(m.index, s.sheets.length)), 0, x); lib.saveSession(s, []); ctxFor(s).sheetsChanged(); }
      } else if (m.t === 'project') { s.project = { ...s.project, ...m.fields }; lib.saveSession(s, []); broadcast(s, sheetsMsg(s)); }
      else if (m.t === 'export') { const f = await lib.exportFiles(s, m.format, m.sheet ? s.docs[m.sheet] : null); send(ws, { t: 'exported', files: f }); }
      else if (m.t === 'outDir') { if (!LOCAL) throw new Error('The output folder is fixed on a hosted server.'); s.outDir = path.resolve(s.cwd, m.dir); lib.saveSession(s, []); broadcast(s, { t: 'outDir', outDir: s.outDir }); }
    } catch (e) { send(ws, { t: 'error', text: String(e.message || e), for: m.t }); }
  });
  ws.on('close', () => s?.clients.delete(ws));
});

server.listen(PORT, HOST, () => console.log(`voltbridge on http://${HOST}:${PORT}  (default cwd ${CWD})\n  chat: ${CHAT ? `${ASSISTANT}${PROVIDER !== 'claude' ? ` (${process.env[PROVIDERS[PROVIDER].model] || 'OPENROUTER_MODEL missing'}${process.env[KEY_VAR] ? '' : `, ${KEY_VAR} missing`})` : ''}` : 'off'}` +
  (AUTH ? `\n  sign-in: Google via Supabase, $${AUTH.userCap.toFixed(2)} per user and $${AUTH.globalCap.toFixed(2)} in total per month` : !LOCAL ? '\n  sign-in: shared access token (set SUPABASE_URL and SUPABASE_SERVICE_KEY for Google sign-in)' : '') +
  (TOKEN && !process.env.VOLTBRIDGE_TOKEN ? `\n  open once from another machine: http://${os.hostname()}:${PORT}/?token=${TOKEN}` : '')));
