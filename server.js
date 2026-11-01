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

// Settings such as GEMINI_API_KEY can live in a git-ignored .env next to this file; real environment variables win.
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
const tokenFile = path.join(lib.HOME, 'token');
const TOKEN = LOCAL ? null : process.env.VOLTBRIDGE_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim()
  : (fs.mkdirSync(lib.HOME, { recursive: true }), fs.writeFileSync(tokenFile, crypto.randomBytes(18).toString('base64url'), { mode: 0o600 }), fs.readFileSync(tokenFile, 'utf8')));
// Who answers the chat. 'claude' is the Claude Code engine: Bash and file access with no prompts, so local only.
// 'gemini' calls the Gemini API with just the voltbridge tools (ai.js), which is what a hosted server uses.
const PROVIDER = process.env.VOLTBRIDGE_PROVIDER || (LOCAL ? 'claude' : 'gemini');
if (!['claude', 'gemini'].includes(PROVIDER)) throw new Error(`VOLTBRIDGE_PROVIDER must be claude or gemini, not "${PROVIDER}"`);
const ASSISTANT = PROVIDER === 'claude' ? 'Claude' : 'Gemini';
// Off loopback the Claude engine stays off unless VOLTBRIDGE_CHAT=1, and clients can't pick the working or output folders on the server's disk.
const CHAT = LOCAL || PROVIDER !== 'claude' || process.env.VOLTBRIDGE_CHAT === '1';
const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const authed = (req) => !TOKEN || same(/(?:^|;\s*)vb=([^;]+)/.exec(req.headers.cookie || '')?.[1], TOKEN);

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
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  // a '+' in the query reads as a space, and base64 tokens contain '+'
  if (TOKEN && same(u.searchParams.get('token')?.replaceAll(' ', '+'), TOKEN)) {
    res.writeHead(302, { 'Set-Cookie': `vb=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, Location: '/' });
    return res.end();
  }
  if (!authed(req)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('voltbridge: open the link with ?token=... printed in the server terminal'); }
  if (req.method === 'POST' && p === '/client-error') {
    let body = ''; req.on('data', (d) => { body += d; }).on('end', () => { console.error('[browser]', body.slice(0, 4000)); res.end(); });
    return;
  }
  const img = p.match(/^\/img\/([^/]+)\/([^/]+)$/);
  const f = img ? (lib.validName(img[1]) && lib.validName(img[2]) ? inside(path.join(lib.SESSIONS, img[1], 'images'), img[2]) : null) : inside(dist, p) || built;
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
const API_PROMPT = `${PROMPT}
You act only through the voltbridge tools: you have no shell and no file access. Each user message starts with [voltbridge] lines naming the sheet the user is looking at and their selection.
If edit_sheet reports errors or issues, fix them and look again before you answer. End with a short summary of what you drew or changed.`;
const DEFAULT_IMAGE_ASK ='Recreate this image as an editable schematic on a new sheet.';

const live = new Map();
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const broadcast = (s, m, except) => s.clients.forEach((ws) => ws !== except && send(ws, m));

function attach(name, cwd) {
  if (!live.has(name)) {
    const fresh = !fs.existsSync(path.join(lib.SESSIONS, name, 'session.json'));
    const s = lib.openSession(name, LOCAL && cwd && fs.existsSync(cwd) ? path.resolve(cwd) : CWD);
    lib.saveSession(s);
    Object.assign(s, { clients: new Set(), q: null, timer: null, dirty: new Set() });
    live.set(name, s);
    if (fresh) allSessions();
  }
  return live.get(name);
}
function touch(s, id) {
  if (id != null) s.dirty.add(id);
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { if (!s.deleted) lib.saveSession(s, [...s.dirty]); s.dirty.clear(); }, 400);
}
const sheetsMsg = (s, goto) => ({ t: 'sheets', sheets: s.sheets, docs: s.docs, project: s.project, goto });
const ctxFor = (s) => ({
  sheetChanged: (doc) => broadcast(s, { t: 'sheet', doc, by: 'claude' }),
  sheetsChanged: (goto) => { broadcast(s, sheetsMsg(s, goto)); allSessions(); },
  exported: (files) => broadcast(s, { t: 'exported', files }),
});

const IMG_LINE = '[voltbridge] pasted images saved as: ';
const imgUrls = (s, line) => line.slice(IMG_LINE.length).split(', ').map((f) => `/img/${encodeURIComponent(s.name)}/${path.basename(f)}`);

async function chat(s, text, images = [], sheetId, selection = []) {
  if (!CHAT) return broadcast(s, { t: 'error', text: 'Chat is turned off on this server. The schematic editor works as usual.' });
  if (s.q) return broadcast(s, { t: 'error', text: `${ASSISTANT} is still working; press Stop first.` });
  if (PROVIDER !== 'claude' && !process.env.GEMINI_API_KEY) return broadcast(s, { t: 'error', text: 'GEMINI_API_KEY is not set on the server, so chat cannot run.' });
  const files = images.length ? lib.saveImages(s, images) : [];
  text = text.trim() || (files.length ? DEFAULT_IMAGE_ASK : '');
  if (!text) return;
  let prefix = `[voltbridge] output folder for exports: ${s.outDir}\n`;
  const doc = s.docs[sheetId];
  if (doc) prefix += `[voltbridge] the user is looking at sheet ${doc.id} "${doc.name}"${selection.length ? `, with selected: ${selection.join(', ')}` : ''}\n`;
  broadcast(s, { t: 'user', text, images: files.length ? imgUrls(s, IMG_LINE + files.join(', ')) : [] });
  if (PROVIDER !== 'claude') return chatApi(s, text, prefix + '\n', files);
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
const getProvider = () => (apiProvider ||= ai.geminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || undefined, baseUrl: process.env.GEMINI_BASE_URL || undefined }));
async function chatApi(s, text, ctx, files) {
  const ac = new AbortController();
  s.q = { interrupt: () => ac.abort() };
  const save = () => { if (!s.deleted) lib.saveChat(s); };
  try {
    s.chat.push({ role: 'user', text, ctx, images: files });
    save();
    await ai.runAgent({
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
    });
  } catch (e) {
    if (!ac.signal.aborted) broadcast(s, { t: 'error', text: String(e.message || e) });
  } finally {
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

const sessionsMsg = () => ({ t: 'sessions', sessions: lib.listSessions() });
const allSessions = () => { const m = sessionsMsg(); wss.clients.forEach((c) => send(c, m)); };
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => authed(req), maxPayload: 32 * 1024 * 1024 });
wss.on('connection', (ws) => {
  let s = null;
  send(ws, { ...sessionsMsg(), t: 'hello', cwd: CWD, assistant: ASSISTANT });
  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    try {
      if (s?.deleted) s = null;
      if (m.t === 'list') send(ws, sessionsMsg());
      else if (m.t === 'open') {
        s?.clients.delete(ws);
        s = attach(m.name, m.cwd);
        s.clients.add(ws);
        send(ws, { t: 'session', name: s.name, cwd: s.cwd, outDir: s.outDir, sheets: s.sheets, docs: s.docs, project: s.project, busy: !!s.q, history: await history(s) });
      } else if (m.t === 'renameSession') {
        const t = live.get(m.from);
        if (t?.q) throw new Error('Claude is working in that session; stop it or wait, then rename.');
        if (t) { clearTimeout(t.timer); lib.saveSession(t); }
        lib.renameSession(m.from, m.to);
        if (t && m.from !== m.to) { live.delete(m.from); Object.assign(t, { name: m.to, dir: path.join(lib.SESSIONS, m.to) }); live.set(m.to, t); broadcast(t, { t: 'renamed', to: m.to }); }
        allSessions();
      } else if (m.t === 'deleteSession') {
        const t = live.get(m.name);
        if (t?.q) throw new Error('Claude is working in that session; stop it or wait, then delete.');
        if (t) { clearTimeout(t.timer); t.deleted = true; live.delete(m.name); }
        lib.deleteSession(m.name);
        if (t) { for (const c of t.clients) send(c, { t: 'deleted', name: m.name, next: lib.listSessions()[0]?.name || 'default' }); t.clients.clear(); }
        allSessions();
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

server.listen(PORT, HOST, () => console.log(`voltbridge on http://${HOST}:${PORT}  (default cwd ${CWD})\n  chat: ${CHAT ? `${ASSISTANT}${PROVIDER === 'gemini' ? ` (${process.env.GEMINI_MODEL || 'default model'}${process.env.GEMINI_API_KEY ? '' : ', GEMINI_API_KEY missing'})` : ''}` : 'off'}` +
  (TOKEN && !process.env.VOLTBRIDGE_TOKEN ? `\n  open once from another machine: http://${os.hostname()}:${PORT}/?token=${TOKEN}` : '')));
