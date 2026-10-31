// Session storage and Claude's schematic tools. No HTTP/WS here, so test.js can drive it directly.
// The schematic lives here on the server (not in the browser), so Claude's tools work with no browser open.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as sch from './web/schematic.js';

export const HOME = path.join(os.homedir(), '.voltbridge');
export const SESSIONS = process.env.VOLTBRIDGE_SESSIONS || path.join(HOME, 'sessions');
export const validName = (n) => /^[\w.-]{1,64}$/.test(n || '') && !/^\.+$/.test(n);
const sheetFile = (s, id) => path.join(s.dir, `sheet-${id}.json`);

export function listSessions(root = SESSIONS) {
  let names; try { names = fs.readdirSync(root); } catch { return []; }
  return names.map((name) => {
    try {
      const f = path.join(root, name, 'session.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      return { name, mtime: fs.statSync(f).mtimeMs, cwd: j.cwd, sheets: (j.sheets || []).length };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
}

export function openSession(name, cwd, root = SESSIONS) {
  if (!validName(name)) throw new Error(`bad session name: ${name}`);
  const dir = path.join(root, name);
  const f = path.join(dir, 'session.json');
  const meta = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8'))
    : { claudeSessionId: null, cwd, outDir: path.join(cwd, 'schematics'), sheets: [{ id: 1 }], project: {} };
  const s = { project: {}, ...meta, name, dir, docs: {} };
  for (const t of s.sheets) {
    try { s.docs[t.id] = JSON.parse(fs.readFileSync(sheetFile(s, t.id), 'utf8')); } catch { s.docs[t.id] = sch.emptySheet(t.id, t.name); }
  }
  s.nextSheetId = Math.max(s.nextSheetId || 1, ...s.sheets.map((t) => t.id + 1));
  return s;
}

export function saveSession(s, ids = s.sheets.map((t) => t.id)) {
  fs.mkdirSync(s.dir, { recursive: true });
  s.sheets = s.sheets.map((t) => ({ id: t.id, name: s.docs[t.id]?.name || t.name }));
  const { claudeSessionId, cwd, outDir, sheets, nextSheetId, project } = s;
  fs.writeFileSync(path.join(s.dir, 'session.json'), JSON.stringify({ claudeSessionId, cwd, outDir, sheets, nextSheetId, project }, null, 2));
  for (const id of ids) if (s.docs[id]) fs.writeFileSync(sheetFile(s, id), JSON.stringify(s.docs[id], null, 1));
}

export function renameSession(from, to, root = SESSIONS) {
  if (!validName(to)) throw new Error('use 1-64 letters, digits, dot, dash or underscore');
  if (!fs.existsSync(path.join(root, from, 'session.json'))) throw new Error(`no session "${from}"`);
  if (from === to) return;
  if (fs.existsSync(path.join(root, to)) && from.toLowerCase() !== to.toLowerCase()) throw new Error(`a session named "${to}" already exists`);
  fs.renameSync(path.join(root, from), path.join(root, to));
}
export function deleteSession(name, root = SESSIONS) {
  if (!validName(name) || !fs.existsSync(path.join(root, name, 'session.json'))) throw new Error(`no session "${name}"`);
  fs.rmSync(path.join(root, name), { recursive: true, force: true });
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export function saveImages(s, images) {
  const dir = path.join(s.dir, 'images');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  return images.map((img, i) => {
    if (!EXT[img.mime]) throw new Error(`unsupported image type ${img.mime}; use png, jpg or webp`);
    const f = `${stamp}-${i}.${EXT[img.mime]}`;
    fs.writeFileSync(path.join(dir, f), Buffer.from(img.data, 'base64'));
    return f;
  });
}

// ---------- sheets ----------
export const allSheets = (s) => s.sheets.map((t) => s.docs[t.id]);
export function findSheet(s, ref) {
  const r = String(ref ?? '').trim().toLowerCase();
  const t = s.sheets.find((x) => String(x.id) === r || (s.docs[x.id]?.name || '').toLowerCase() === r);
  if (!t) throw new Error(`no sheet "${ref}". Sheets: ${s.sheets.map((x) => `${x.id}:${s.docs[x.id].name}`).join(', ') || 'none'}`);
  return s.docs[t.id];
}
export function addSheet(s, name, size) {
  const id = s.nextSheetId++;
  const doc = sch.emptySheet(id, name);
  if (size && sch.SIZES[size]) doc.size = size;
  s.sheets.push({ id, name: doc.name });
  s.docs[id] = doc;
  saveSession(s, [id]);
  return doc;
}
export function removeSheet(s, id) {
  s.sheets = s.sheets.filter((t) => t.id !== id);
  delete s.docs[id];
  try { fs.unlinkSync(sheetFile(s, id)); } catch {}
  saveSession(s, []);
}
// A sheet from the editor replaces ours when it was based on our latest revision; otherwise the editor is told to reload.
export function putSheet(s, doc, baseRev) {
  const cur = s.docs[doc.id];
  if (!cur) throw new Error(`no sheet ${doc.id}`);
  if (baseRev !== cur.rev) return false;
  s.docs[doc.id] = { ...doc, rev: cur.rev + 1 };
  return true;
}
export function editSheet(s, sheet, ops) {
  const r = sch.applyOps(sheet, ops, allSheets(s));
  sheet.rev = (sheet.rev || 0) + 1;
  saveSession(s, [sheet.id]);
  return r;
}

// ---------- exports ----------
let Resvg = null;
export async function png(svg, width = 2000) {
  Resvg ||= (await import('@resvg/resvg-js')).Resvg;
  return new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } }).render().asPng();
}
const fileBase = (doc) => `${String(doc.id).padStart(2, '0')}-${doc.name.replace(/[^\w.-]+/g, '_')}`;
// Writes export files into the output folder; returns their paths.
export async function exportFiles(s, format, doc) {
  fs.mkdirSync(s.outDir, { recursive: true });
  const sheets = allSheets(s), out = [];
  const put = (name, data) => { const f = path.join(s.outDir, name); fs.writeFileSync(f, data); out.push(f); };
  const which = doc ? [doc] : sheets;
  if (format === 'svg') for (const d of which) put(`${fileBase(d)}.svg`, sch.sheetSvg(d, sheets, sch.LIGHT, s.project));
  else if (format === 'png') for (const d of which) put(`${fileBase(d)}.png`, await png(sch.sheetSvg(d, sheets, sch.LIGHT, s.project), 3000));
  else if (format === 'bom') put(`${s.name}-bom.csv`, sch.bomCsv(sheets));
  else if (format === 'netlist') put(`${s.name}-netlist.csv`, sch.netlistCsv(sheets));
  else if (format === 'json') put(`${s.name}.voltbridge.json`, JSON.stringify({ project: s.project, sheets }, null, 1));
  else throw new Error(`format must be svg, png, bom, netlist or json`);
  return out;
}

// ---------- Claude's tools ----------
const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t) }] });
const guard = (fn) => async (args) => { try { return await fn(args); } catch (e) { return { ...text(String(e.message || e)), isError: true }; } };
const symbolList = (q) => Object.values(sch.SYMBOLS).filter((x) => !q || `${x.key} ${x.name} ${x.cat}`.toLowerCase().includes(q.toLowerCase())).map((x) => {
  const sym = x.dynamic ? sch.symbolOf({ sym: x.key, props: {} }) : x;
  return { sym: x.key, name: x.name, cat: x.cat, prefix: x.prefix || null, pins: sym.pins.map((p) => `${p.n}@${p.x},${p.y}`).join(' '), box: sym.box, ...(x.power ? { net: x.power } : {}), ...(x.contact ? { contact: true } : {}), ...(x.dynamic ? { props: x.props } : {}), ...(x.value ? { value: x.value } : {}) };
});

const OPS_DOC = `ops, applied in order (all coordinates snap to the 10px grid; sheet origin top left, y grows down):
- {op:"add", sym, x, y, ref?, rot?: 0|90|180|270, mirror?, props?} places a symbol; ref is auto-numbered from the symbol's prefix when omitted (K1, Q2...). props: value, partNo, maker, description, or anything else.
- {op:"connect", from:"K1:A1", to:"F1:2", via?:[[x,y],...]} draws an orthogonal wire between two pins (or [x,y] points). Pass via points to steer it around parts.
- {op:"wire", pts:[[x,y],...], kind?:"bus"} draws a wire through exact points; segments must be horizontal or vertical. kind "bus" draws a thick busbar (single-line diagrams).
- {op:"label", text, x, y, kind?:"net"|"text"} a net label at a point on a wire or pin names that net; the same name on any sheet is the same net. kind "text" is a free note.
- {op:"update", id|ref, x?, y?, rot?, mirror?, newRef?, sym?, props?} (props merge, null removes one); moving a part drags the wire ends on its pins. For wires: {op:"update", id, pts?, kind?}; labels: text, x, y.
- {op:"delete", id|ref} a part, wire or label.
- {op:"sheet", name?, size?: A4|A3|A2|A1, title?: {title, drawingNo, rev, author, date}}.
Several parts may share a ref: a coil K1 and its contacts K1 (contact_no/contact_nc/contactor_3p), each with distinct pin numbers (13-14, 23-24, 21-22...). Pin refs "K1:23" find the right one.`;

export function makeTools(s, ctx) {
  const opts = { alwaysLoad: true };
  const changed = (doc) => ctx.sheetChanged(doc);
  return [
    tool('list_sheets', 'List the sheets of this voltbridge project: [{id, name, size, parts, wires}] and the project title fields.', {},
      guard(async () => text({ project: s.project, sheets: allSheets(s).map((d) => ({ id: d.id, name: d.name, size: d.size, parts: d.parts.length, wires: d.wires.length })) })), opts),
    tool('list_symbols', 'List the symbol library: {sym, name, cat, prefix, pins: "NAME@x,y ..." (local coords, rot 0), box: [x1,y1,x2,y2]}. Two-terminal parts stand vertically, pin 1 on top; rot 90 lays them horizontally. Optional query filters by text.',
      { query: z.string().optional() }, guard(async ({ query }) => text(symbolList(query))), opts),
    tool('get_sheet', 'Read a sheet: parts {id, ref, sym, x, y, rot, props, zone, bbox, pins: {NAME: {at:[x,y], net}}}, wires {id, pts, net}, labels, nets {name, nodes}, and issues (unconnected pins, diagonal wires, contacts without a coil...). The sheet extent is given in px; keep the drawing inside it, clear of the title block (bottom right 380x100).',
      { sheet: z.string().describe('sheet id or name') }, guard(async ({ sheet }) => text(sch.describe(findSheet(s, sheet), allSheets(s)))), opts),
    tool('edit_sheet', `Change a sheet in one batch. ${OPS_DOC} Returns {added: ["p3=K1", "w4", ...], errors, warnings, issues}. Invalid ops are reported one by one; the rest apply.`,
      { sheet: z.string().describe('sheet id or name'), ops: z.array(z.record(z.string(), z.any())) },
      guard(async ({ sheet, ops }) => {
        const doc = findSheet(s, sheet);
        const r = editSheet(s, doc, ops);
        changed(doc);
        return { ...text({ ...r, issues: sch.check(doc, allSheets(s)).slice(0, 40) }), isError: r.errors.length === ops.length && ops.length > 0 };
      }), opts),
    tool('new_sheet', 'Create a new empty sheet (default A3 landscape, 1680x1190 px) and return its id.', { name: z.string().optional(), size: z.enum(['A4', 'A3', 'A2', 'A1']).optional() },
      guard(async ({ name, size }) => { const d = addSheet(s, name, size); ctx.sheetsChanged(d.id); return text({ id: d.id, name: d.name, size: d.size, extent: sch.SIZES[d.size] }); }), opts),
    tool('delete_sheet', 'Delete a sheet.', { sheet: z.string() },
      guard(async ({ sheet }) => { const d = findSheet(s, sheet); removeSheet(s, d.id); ctx.sheetsChanged(); return text(`deleted sheet ${d.id} "${d.name}"`); }), opts),
    tool('set_project', 'Set project-wide title block fields shown on every sheet (title, drawingNo, rev, author, date, company). A sheet\'s own title fields override them.',
      { fields: z.record(z.string(), z.string()) }, guard(async ({ fields }) => { s.project = { ...s.project, ...fields }; saveSession(s, []); ctx.sheetsChanged(); return text(s.project); }), opts),
    tool('snapshot', 'Render a sheet to PNG so you can see it. Use it after drawing to check spacing, overlaps and text.', { sheet: z.string(), width: z.number().optional().describe('px, default 1600') },
      guard(async ({ sheet, width }) => {
        const d = findSheet(s, sheet);
        const buf = await png(sch.sheetSvg(d, allSheets(s), sch.LIGHT, s.project), Math.min(width || 1600, 3000));
        return { content: [{ type: 'image', data: Buffer.from(buf).toString('base64'), mimeType: 'image/png' }] };
      }), opts),
    tool('get_netlist', 'Netlist of the whole project: [{name, nodes: ["K1:A1", ...], sheets}]. Named nets (labels, power symbols) join across sheets.', {},
      guard(async () => text(sch.netlist(allSheets(s)))), opts),
    tool('get_bom', 'Bill of materials of the whole project: [{qty, refs, symbol, value, partNo, maker, description}]. Contacts are folded into their device.', {},
      guard(async () => text(sch.bom(allSheets(s)))), opts),
    tool('export', 'Write files to the output folder: svg or png (one sheet, or all when sheet is omitted), bom or netlist (CSV), json (the whole project). Returns the paths.',
      { format: z.enum(['svg', 'png', 'bom', 'netlist', 'json']), sheet: z.string().optional() },
      guard(async ({ format, sheet }) => { const f = await exportFiles(s, format, sheet ? findSheet(s, sheet) : null); ctx.exported?.(f); return text(f); }), opts),
  ];
}

export const makeMcp = (s, ctx) => createSdkMcpServer({ name: 'voltbridge', version: '0.1.0', tools: makeTools(s, ctx) });
