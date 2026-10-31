// Panels around the canvas: symbol palette, toolbar, inspector, export menu, status bar.
import React, { useMemo, useState } from 'react';
import * as sch from './schematic.js';
import { Icon, store, useEscape } from './ui.jsx';

// ---------- palette ----------
export function Palette({ tool, setTool, theme }) {
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState(() => { try { return JSON.parse(store.get('vb-palette') || '{}'); } catch { return {}; } });
  const C = theme === 'dark' ? sch.DARK : sch.LIGHT;
  const previews = useMemo(() => Object.fromEntries(Object.keys(sch.SYMBOLS).map((k) => [k, sch.symbolPreview(k, C)])), [theme]);
  const match = (s) => !q || `${s.key} ${s.name} ${s.cat} ${s.prefix || ''}`.toLowerCase().includes(q.toLowerCase());
  const toggle = (c) => { const n = { ...closed, [c]: !closed[c] }; setClosed(n); store.set('vb-palette', JSON.stringify(n)); };
  return (
    <div className="palette">
      <div className="psearch"><Icon n="search" s={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search symbols" aria-label="Search symbols" /></div>
      <div className="plib">
        {sch.CATEGORIES.map((cat) => {
          const syms = Object.values(sch.SYMBOLS).filter((s) => s.cat === cat && match(s));
          if (!syms.length) return null;
          const open = q || !closed[cat];
          return (
            <div key={cat}>
              <button className="pcat" onClick={() => toggle(cat)}><span className={`tchev ${open ? 'open' : ''}`}><Icon n="chev" s={12} /></span>{cat}</button>
              {open && <div className="pgrid">{syms.map((s) => (
                <button key={s.key} className={`psym ${tool === `place:${s.key}` ? 'on' : ''}`} title={`${s.name}${s.prefix ? ` (${s.prefix})` : ''}`} onClick={() => setTool(tool === `place:${s.key}` ? 'select' : `place:${s.key}`)}>
                  <span className="pimg" dangerouslySetInnerHTML={{ __html: previews[s.key] }} />
                  <span className="pname">{s.name}</span>
                </button>))}
              </div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- toolbar ----------
const TOOLS = [['select', 'Select', 'V'], ['wire', 'Wire', 'W'], ['bus', 'Busbar', 'B'], ['net', 'Net label', 'N'], ['text', 'Text', 'T']];
export function Toolbar({ tool, setTool, hasSel, act, canUndo, canRedo }) {
  return (
    <div className="toolbar">
      <div className="seg tools">{TOOLS.map(([k, n, key]) => <button key={k} className={tool === k ? 'on' : ''} onClick={() => setTool(k)} title={`${n} (${key})`}>{n}</button>)}</div>
      {tool.startsWith('place:') && <span className="placing">Placing {sch.SYMBOLS[tool.slice(6)]?.name}: click to place, R rotate, Esc stop</span>}
      <span className="tsep" />
      <button className="ghost" disabled={!hasSel} onClick={() => act('rotate')} title="Rotate 90° (R, Shift+R back)">Rotate</button>
      <button className="ghost" disabled={!hasSel} onClick={() => act('mirror')} title="Mirror (X)">Mirror</button>
      <button className="ghost" disabled={!hasSel} onClick={() => act('delete')} title="Delete (Del)">Delete</button>
      <span className="tsep" />
      <button className="ghost" disabled={!canUndo} onClick={() => act('undo')} title="Undo (Ctrl+Z)">Undo</button>
      <button className="ghost" disabled={!canRedo} onClick={() => act('redo')} title="Redo (Ctrl+Y)">Redo</button>
    </div>
  );
}

// ---------- inspector ----------
// An input that commits on Enter or blur, not on every keystroke (each commit is an undo step and a save).
function Field({ label, value, onSave, mono, list }) {
  const [v, setV] = useState(value ?? '');
  const [was, setWas] = useState(value);
  if (was !== value) { setWas(value); setV(value ?? ''); }
  const save = () => { if (String(v) !== String(value ?? '')) onSave(v); };
  return (
    <label className="ifield">{label}
      <input value={v} list={list} className={mono ? 'mono' : ''} onChange={(e) => setV(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); e.target.blur(); } if (e.key === 'Escape') { setV(value ?? ''); e.target.blur(); } }} />
    </label>
  );
}

const TITLE_FIELDS = [['title', 'Title'], ['drawingNo', 'Drawing no.'], ['rev', 'Revision'], ['author', 'Drawn by'], ['date', 'Date'], ['company', 'Company']];
export function Inspector({ doc, sheets, sel, setSel, edit, project, setProject, showIssues }) {
  const conn = useMemo(() => sch.connectivity(doc), [doc]);
  const netAt = (x, y) => { const i = conn.pointNet.get(sch.ptKey(x, y)); return i == null ? null : conn.nets[i].name; };
  const ids = [...sel];
  const one = ids.length === 1 ? ids[0] : null;
  const part = one && doc.parts.find((p) => p.id === one);
  const wire = one && doc.wires.find((w) => w.id === one);
  const label = one && doc.labels.find((l) => l.id === one);
  const upd = (id, fn) => edit((d) => { const x = [...d.parts, ...d.wires, ...d.labels].find((y) => y.id === id); if (x) fn(x, d); });
  const issues = sch.check(doc, sheets);
  const xr = sch.crossRefs(sheets);
  const [newKey, setNewKey] = useState('');

  if (part) {
    const sym = sch.symbolOf(part);
    const fixed = new Set(['value', 'partNo', 'maker', 'description', 'net']);
    const extra = Object.keys(part.props || {}).filter((k) => !fixed.has(k));
    const r = xr[part.ref];
    return (
      <div className="inspector">
        <div className="ihead"><span className="kdot" /><b>{part.ref}</b><span className="muted">{sym.name}</span></div>
        {sym.power ? <Field label="Net name" value={part.props?.net} onSave={(v) => upd(part.id, (x) => { x.props.net = v; x.ref = v; })} />
          : <Field label="Designator" value={part.ref} onSave={(v) => upd(part.id, (x) => { x.ref = v.trim(); })} />}
        <label className="ifield">Symbol
          <select value={part.sym} onChange={(e) => upd(part.id, (x) => { x.sym = e.target.value; })}>
            {sch.CATEGORIES.map((c) => <optgroup key={c} label={c}>{Object.values(sch.SYMBOLS).filter((s) => s.cat === c).map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</optgroup>)}
          </select>
        </label>
        {!sym.power && <>
          <Field label="Value / rating" value={part.props?.value} onSave={(v) => upd(part.id, (x) => { x.props.value = v; })} />
          <Field label="Part number" value={part.props?.partNo} onSave={(v) => upd(part.id, (x) => { x.props.partNo = v; })} />
          <Field label="Maker" value={part.props?.maker} onSave={(v) => upd(part.id, (x) => { x.props.maker = v; })} />
          <Field label="Description" value={part.props?.description} onSave={(v) => upd(part.id, (x) => { x.props.description = v; })} />
        </>}
        {extra.map((k) => (
          <div key={k} className="iprop">
            <Field label={k} value={part.props[k]} mono={/^(left|right|top|bottom)$/.test(k)} onSave={(v) => upd(part.id, (x) => { x.props[k] = v; })} />
            <button className="iconbtn" title={`Remove ${k}`} onClick={() => upd(part.id, (x) => { delete x.props[k]; })}><Icon n="x" s={12} /></button>
          </div>
        ))}
        <form className="iadd row" onSubmit={(e) => { e.preventDefault(); const k = newKey.trim(); if (k) { upd(part.id, (x) => { x.props[k] = ''; }); setNewKey(''); } }}>
          <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="add property" aria-label="New property name" /><button className="ghost" type="submit">Add</button>
        </form>
        <div className="iactions">
          <button className="ghost" onClick={() => edit((d) => sch.turnParts(d, [part.id], { rot: 90 }))}>Rotate</button>
          <button className="ghost" onClick={() => edit((d) => sch.turnParts(d, [part.id], { mirror: true }))}>Mirror</button>
          <span className="muted small">at {part.x}, {part.y} · {sch.zoneOf(doc, part.x, part.y)} · {part.rot || 0}°</span>
        </div>
        <div className="isec">Pins</div>
        <div className="pins">{sch.pinsOf(part).map((q) => <div key={q.name} className="irel"><span className="mono">{q.name}</span><span className={netAt(q.x, q.y) ? '' : 'warn'}>{netAt(q.x, q.y) || 'not connected'}</span></div>)}</div>
        {r && !sym.power && (r.contacts.length > 0 || (sym.contact && r.device)) && <>
          <div className="isec">Cross references</div>
          {sym.contact ? <div className="irel"><span>coil / device</span><span>{r.device.loc}</span></div>
            : r.contacts.map((k) => <div key={k.id} className="irel"><span>{k.kind} {k.pins}</span><span>{k.loc}</span></div>)}
        </>}
        <button className="danger" onClick={() => { edit((d) => sch.removeItems(d, [part.id])); setSel(new Set()); }}><Icon n="trash" s={13} /> Delete part</button>
      </div>
    );
  }
  if (wire) {
    const net = netAt(...wire.pts[0]);
    const n = conn.nets.find((x) => x.name === net);
    return (
      <div className="inspector">
        <div className="ihead"><b>{wire.kind === 'bus' ? 'Busbar' : 'Wire'}</b><span className="muted">{wire.id}</span></div>
        <label className="icheck"><input type="checkbox" checked={wire.kind === 'bus'} onChange={(e) => upd(wire.id, (x) => { if (e.target.checked) x.kind = 'bus'; else delete x.kind; })} /> Busbar (thick)</label>
        <div className="isec">Net {net}</div>
        {n?.nodes.map((x) => <div key={x} className="irel"><span className="mono">{x}</span></div>)}
        {!n?.named && <p className="muted small">Add a net label (N) on this wire to name the net; the same name on another sheet joins them.</p>}
        <button className="danger" onClick={() => { edit((d) => sch.removeItems(d, [wire.id])); setSel(new Set()); }}><Icon n="trash" s={13} /> Delete wire</button>
      </div>
    );
  }
  if (label) {
    return (
      <div className="inspector">
        <div className="ihead"><b>{label.kind === 'net' ? 'Net label' : 'Text'}</b></div>
        <Field label="Text" value={label.text} onSave={(v) => upd(label.id, (x) => { x.text = v; })} />
        <label className="ifield">Kind<select value={label.kind} onChange={(e) => upd(label.id, (x) => { x.kind = e.target.value; })}><option value="net">Net label (names the net)</option><option value="text">Free text</option></select></label>
        <button className="danger" onClick={() => { edit((d) => sch.removeItems(d, [label.id])); setSel(new Set()); }}><Icon n="trash" s={13} /> Delete</button>
      </div>
    );
  }
  if (ids.length > 1) {
    return (
      <div className="inspector">
        <div className="ihead"><b>{ids.length} selected</b></div>
        <p className="muted small">Drag to move, R rotate, X mirror, Ctrl+D duplicate, Ctrl+C / Ctrl+V copy to another sheet.</p>
        <button className="danger" onClick={() => { edit((d) => sch.removeItems(d, ids)); setSel(new Set()); }}><Icon n="trash" s={13} /> Delete {ids.length}</button>
      </div>
    );
  }
  return (
    <div className="inspector">
      <div className="ihead"><b>Sheet {doc.id}</b></div>
      <Field label="Sheet name" value={doc.name} onSave={(v) => edit((d) => { d.name = v || d.name; })} />
      <label className="ifield">Size<select value={doc.size} onChange={(e) => edit((d) => { d.size = e.target.value; })}>{Object.entries(sch.SIZES).map(([k, [w, h]]) => <option key={k} value={k}>{k} landscape ({w}×{h})</option>)}</select></label>
      <div className="isec">Title block (this sheet)</div>
      {TITLE_FIELDS.map(([k, n]) => <Field key={k} label={n} value={doc.title?.[k] ?? ''} onSave={(v) => edit((d) => { d.title = { ...d.title, [k]: v }; if (!v) delete d.title[k]; })} />)}
      <div className="isec">Project defaults (all sheets)</div>
      {TITLE_FIELDS.filter(([k]) => k !== 'title').map(([k, n]) => <Field key={k} label={n} value={project?.[k] ?? ''} onSave={(v) => setProject({ [k]: v })} />)}
      <div className="isec" ref={(el) => { if (showIssues && el) el.scrollIntoView({ block: 'start' }); }}>Checks ({issues.length})</div>
      {issues.length === 0 ? <p className="muted small">No issues found.</p> : issues.slice(0, 60).map((x) => <div key={x} className="issue"><Icon n="alert" s={12} />{x}</div>)}
      <div className="isec">Nets ({conn.nets.length})</div>
      {conn.nets.slice(0, 80).map((n) => <div key={n.id} className="irel"><span className={n.named ? 'mono b' : 'mono'}>{n.name}</span><span className="muted small">{n.nodes.join(' ')}</span></div>)}
    </div>
  );
}

// ---------- export ----------
const download = (name, data, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
const fileName = (doc) => `${String(doc.id).padStart(2, '0')}-${doc.name.replace(/[^\w.-]+/g, '_')}`;
async function svgToPng(svg, w, h, scale = 2) {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const c = document.createElement('canvas'); c.width = w * scale; c.height = h * scale;
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise((ok) => c.toBlob(ok, 'image/png'));
}
function printAll(sheets, project) {
  const pages = sheets.map((d) => sch.sheetSvg(d, sheets, sch.LIGHT, project).replace(/width="\d+" height="\d+"/, 'width="100%" height="100%" preserveAspectRatio="xMidYMid meet"'));
  const w = open('', '_blank');
  if (!w) return alert('Allow pop-ups for this page to print.');
  w.document.write(`<!doctype html><title>${project.title || 'schematic'}</title><style>@page{size:A3 landscape;margin:0}html,body{margin:0}.pg{width:100vw;height:100vh;page-break-after:always;display:flex}svg{flex:1}</style>${pages.map((p) => `<div class="pg">${p}</div>`).join('')}<script>onload=()=>setTimeout(()=>print(),200)<\/script>`);
  w.document.close();
}
export function ExportMenu({ doc, sheets, project, sessName, tx }) {
  const [open, setOpen] = useState(false);
  useEscape(open, () => setOpen(false));
  const go = async (k) => {
    setOpen(false);
    const svg = () => sch.sheetSvg(doc, sheets, sch.LIGHT, project);
    if (k === 'svg') download(`${fileName(doc)}.svg`, svg(), 'image/svg+xml');
    else if (k === 'png') { const [w, h] = sch.SIZES[doc.size] || sch.SIZES.A3; download(`${fileName(doc)}.png`, await svgToPng(svg(), w, h), 'image/png'); }
    else if (k === 'pdf') printAll(sheets, project);
    else if (k === 'bom') download(`${sessName}-bom.csv`, sch.bomCsv(sheets), 'text/csv');
    else if (k === 'netlist') download(`${sessName}-netlist.csv`, sch.netlistCsv(sheets), 'text/csv');
    else if (k === 'json') download(`${sessName}.voltbridge.json`, JSON.stringify({ project, sheets }, null, 1), 'application/json');
    else if (k === 'server') for (const f of ['svg', 'png', 'bom', 'netlist']) tx({ t: 'export', format: f });
  };
  const items = [['svg', 'This sheet as SVG'], ['png', 'This sheet as PNG'], ['pdf', 'All sheets: print / PDF'], null, ['bom', 'Bill of materials (CSV)'], ['netlist', 'Netlist (CSV)'], ['json', 'Project (JSON)'], null, ['server', 'Write all to the output folder']];
  return (
    <div className="picker">
      <button className="ghost" onClick={() => setOpen(!open)} aria-expanded={open}><Icon n="export" s={14} /> Export <Icon n="chev" s={12} /></button>
      {open && <><div className="scrim" onClick={() => setOpen(false)} /><div className="pop right cmenu-pop">{items.map((x, i) => (x ? <button key={x[0]} className="prow" onClick={() => go(x[0])}>{x[1]}</button> : <div key={i} className="csep" />))}</div></>}
    </div>
  );
}

// ---------- status bar ----------
export function StatusBar({ st, tool, onIssues }) {
  const hint = tool === 'wire' || tool === 'bus' ? 'Click to start/bend, click a pin or wire to finish, double-click or right-click to end, / flips the corner'
    : tool === 'net' ? 'Click a wire or pin to name its net' : tool === 'text' ? 'Click to place a note'
      : tool.startsWith('place:') ? 'Click to place · R rotate · right-click or Esc to stop'
        : 'Drag to move · box-select (right-to-left touches) · wheel zoom · middle/right-drag or Space pans · Ctrl+Z undo';
  return (
    <div className="status">
      <span className="mono">{st.cursor?.[0]}, {st.cursor?.[1]}</span>
      <span className="mono">{st.zone}</span>
      {st.hover && <span className="shover">{st.hover}</span>}
      <span className="grow shint">{hint}</span>
      <button className={`sissues ${st.issues?.length ? 'bad' : ''}`} onClick={onIssues} title="Show checks">{st.issues?.length ? <><Icon n="alert" s={12} /> {st.issues.length} issue{st.issues.length > 1 ? 's' : ''}</> : <><Icon n="check" s={12} /> no issues</>}</button>
    </div>
  );
}
