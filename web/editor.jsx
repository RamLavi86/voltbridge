// The schematic canvas: pan/zoom SVG, select/move/rotate, wire drawing, symbol placement, net labels.
// It never owns the sheet: every finished edit goes to onCommit(nextDoc); drags preview locally until the pointer is released.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as sch from './schematic.js';

const { snap, ptKey } = sch;
const clone = (d) => structuredClone(d);
const svgCache = new Map(); // "theme|part json" -> markup; parts are re-cloned on every edit, so key on content
function partMarkup(p, c, theme) {
  const k = theme + JSON.stringify(p);
  let v = svgCache.get(k);
  if (v == null) { v = sch.partSvg(p, c); if (svgCache.size > 4000) svgCache.clear(); svgCache.set(k, v); }
  return v;
}
const labelBox = (l) => (l.kind === 'net' ? [l.x, l.y - 8, l.x + Math.max(20, l.text.length * 6.6 + 10) + 6, l.y + 8] : [l.x, l.y - 7, l.x + l.text.length * 6.2, l.y + 7]);
const wireBox = (w) => [Math.min(...w.pts.map((p) => p[0])), Math.min(...w.pts.map((p) => p[1])), Math.max(...w.pts.map((p) => p[0])), Math.max(...w.pts.map((p) => p[1]))];
const hits = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const inside = (a, b) => a[0] >= b[0] && a[2] <= b[2] && a[1] >= b[1] && a[3] <= b[3];
export const itemsIn = (doc) => [...doc.parts.map((p) => [p.id, sch.bboxOf(p)]), ...doc.wires.map((w) => [w.id, wireBox(w)]), ...doc.labels.map((l) => [l.id, labelBox(l)])];

// Elbow from a to b: horizontal first, or vertical first when flip.
const elbow = (a, b, flip) => (a[0] === b[0] || a[1] === b[1] ? [b] : flip ? [[a[0], b[1]], b] : [[b[0], a[1]], b]);

// Moves the selection: parts drag their wires, selected wires and labels translate.
function moveSel(doc, ids, dx, dy) {
  const set = new Set(ids);
  const own = doc.wires.filter((w) => set.has(w.id));
  doc.wires = doc.wires.filter((w) => !set.has(w.id));
  sch.moveParts(doc, doc.parts.filter((p) => set.has(p.id)).map((p) => p.id), dx, dy);
  doc.wires.push(...own.map((w) => ({ ...w, pts: w.pts.map(([x, y]) => [x + dx, y + dy]) })));
  for (const l of doc.labels) if (set.has(l.id)) { l.x += dx; l.y += dy; }
}

// Pastes clipboard items { parts, wires, labels } (positions relative to their origin) at (x, y). Returns new ids.
export function paste(doc, clip, x, y, sheets) {
  const tmp = { ...doc, parts: [...doc.parts, ...clip.parts.map((p, i) => ({ ...clone(p), id: `__c${i}` }))], wires: [...doc.wires, ...clip.wires.map((w, i) => ({ ...clone(w), id: `__w${i}` }))], labels: [...doc.labels, ...clip.labels.map((l, i) => ({ ...l, id: `__l${i}` }))] };
  const ids = [...clip.parts.map((_, i) => `__c${i}`), ...clip.wires.map((_, i) => `__w${i}`), ...clip.labels.map((_, i) => `__l${i}`)];
  const added = sch.duplicate(tmp, ids, x, y, sheets);
  Object.assign(doc, { parts: tmp.parts.filter((p) => !p.id.startsWith('__')), wires: tmp.wires.filter((w) => !w.id.startsWith('__')), labels: tmp.labels.filter((l) => !l.id.startsWith('__')), nextId: tmp.nextId });
  return added;
}

export function Editor({ doc, sheets, project, theme, tool, setTool, sel, setSel, onCommit, onUndo, onRedo, onStatus, onOpenItem, clip, setClip, ask }) {
  const C = theme === 'dark' ? sch.DARK : sch.LIGHT;
  const svg = useRef(null);
  const views = useRef({}); // sheet id -> { x, y, k }
  const [view, setView] = useState(null);
  const [preview, setPreview] = useState(null); // doc while dragging
  const [cursor, setCursor] = useState([0, 0]);
  const [wire, setWire] = useState(null); // in-progress wire points
  const [flip, setFlip] = useState(false);
  const [ghostRot, setGhostRot] = useState(0);
  const [box, setBox] = useState(null);
  const [hover, setHover] = useState(null);
  const [space, setSpace] = useState(false);
  const drag = useRef(null);
  const shown = preview || doc;
  const conn = useMemo(() => sch.connectivity(shown), [shown]);
  const issues = useMemo(() => sch.check(doc, sheets), [doc, sheets]);
  const [W, H] = sch.SIZES[shown.size] || sch.SIZES.A3;

  // ---------- view ----------
  const fit = () => {
    const r = svg.current?.getBoundingClientRect();
    if (!r?.width) return;
    const k = Math.min(r.width / (W + 40), r.height / (H + 40));
    const v = { k, x: (r.width - W * k) / 2, y: (r.height - H * k) / 2 };
    views.current[doc.id] = v; setView(v);
  };
  useEffect(() => { const v = views.current[doc.id]; if (v) setView(v); else fit(); setWire(null); setPreview(null); }, [doc.id]);
  useEffect(() => { const ro = new ResizeObserver(() => { if (!views.current[doc.id]) fit(); }); ro.observe(svg.current); return () => ro.disconnect(); }, [doc.id]);
  const setV = (v) => { views.current[doc.id] = v; setView(v); };
  const zoomBy = (f) => { const r = svg.current.getBoundingClientRect(), v = views.current[doc.id], mx = r.width / 2, my = r.height / 2, k = Math.min(8, Math.max(0.08, v.k * f)); setV({ k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) }); };
  const world = (e) => { const r = svg.current.getBoundingClientRect(), v = views.current[doc.id] || view; return [(e.clientX - r.left - v.x) / v.k, (e.clientY - r.top - v.y) / v.k]; };
  useEffect(() => {
    const el = svg.current;
    const wheel = (e) => {
      e.preventDefault();
      const v = views.current[doc.id]; if (!v) return;
      const r = el.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) { setV({ ...v, x: v.x - e.deltaX }); return; }
      const k = Math.min(8, Math.max(0.08, v.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
      setV({ k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [doc.id]);

  // ---------- editing helpers ----------
  const commit = (fn) => { const d = clone(doc); const r = fn(d); onCommit(d); return r; };
  const isConn = (p) => {
    const k = ptKey(...p);
    if (doc.parts.some((q) => sch.pinsOf(q).some((x) => x.x === p[0] && x.y === p[1]))) return true;
    return doc.wires.some((w) => w.pts.some(([x, y], i) => ptKey(x, y) === k || (i && ((x === p[0] && w.pts[i - 1][0] === x && (p[1] - y) * (p[1] - w.pts[i - 1][1]) <= 0) || (y === p[1] && w.pts[i - 1][1] === y && (p[0] - x) * (p[0] - w.pts[i - 1][0]) <= 0)))));
  };
  const finishWire = (pts) => {
    const p = sch.simplify(pts || wire || []);
    setWire(null);
    if (p.length >= 2) commit((d) => sch.addWire(d, p, tool === 'bus' ? 'bus' : undefined));
  };
  const placeLabel = async (kind, at) => {
    const text = await ask(kind === 'net' ? 'Net name (e.g. L1, +24V, 0V)' : 'Text');
    if (text?.trim()) commit((d) => { const id = sch.addLabel(d, text.trim(), at[0], at[1], kind); setSel(new Set([id])); });
  };

  // ---------- pointer ----------
  function down(e) {
    svg.current.setPointerCapture(e.pointerId);
    const w = world(e), p = [snap(w[0]), snap(w[1])];
    const v = views.current[doc.id];
    if (e.button === 1 || e.button === 2 || (e.button === 0 && space)) { drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, v, moved: false, right: e.button === 2 }; return; }
    if (e.button !== 0) return;
    if (tool.startsWith('place:')) {
      commit((d) => { const id = sch.addPart(d, tool.slice(6), p[0], p[1], ghostRot, sheets.filter((s) => s.id !== d.id).concat(d)); setSel(new Set([id])); });
      if (!e.shiftKey) { /* keep placing more of the same; Esc or right-click stops */ }
      return;
    }
    if (tool === 'wire' || tool === 'bus') {
      if (!wire) { setWire([p]); setFlip(false); return; }
      const last = wire.at(-1);
      if (last[0] === p[0] && last[1] === p[1]) return;
      const pts = [...wire, ...elbow(last, p, flip)];
      if (isConn(p) && !(p[0] === wire[0][0] && p[1] === wire[0][1])) finishWire(pts);
      else { setWire(pts); setFlip(false); }
      return;
    }
    if (tool === 'net' || tool === 'text') { placeLabel(tool, p); setTool('select'); return; }
    const id = e.target.closest?.('[data-id]')?.dataset.id;
    if (id) {
      let next = sel;
      if (e.shiftKey || e.ctrlKey) { next = new Set(sel); next.has(id) ? next.delete(id) : next.add(id); }
      else if (!sel.has(id)) next = new Set([id]);
      setSel(next);
      drag.current = { kind: 'move', start: p, ids: [...next], dx: 0, dy: 0 };
    } else {
      if (!e.shiftKey) setSel(new Set());
      drag.current = { kind: 'box', start: w, add: e.shiftKey };
    }
  }
  function move(e) {
    const w = world(e), p = [snap(w[0]), snap(w[1])];
    if (p[0] !== cursor[0] || p[1] !== cursor[1]) setCursor(p);
    const g = drag.current;
    if (!g) { setHover(e.target.closest?.('[data-id]')?.dataset.id || null); return; }
    if (g.kind === 'pan') {
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
      setV({ ...g.v, x: g.v.x + dx, y: g.v.y + dy });
    } else if (g.kind === 'move') {
      const dx = p[0] - g.start[0], dy = p[1] - g.start[1];
      if (dx === g.dx && dy === g.dy) return;
      g.dx = dx; g.dy = dy;
      const d = clone(doc); moveSel(d, g.ids, dx, dy); setPreview(d);
    } else if (g.kind === 'box') setBox([Math.min(g.start[0], w[0]), Math.min(g.start[1], w[1]), Math.max(g.start[0], w[0]), Math.max(g.start[1], w[1]), w[0] < g.start[0]]);
  }
  function up() {
    const g = drag.current; drag.current = null;
    if (!g) return;
    if (g.kind === 'move' && (g.dx || g.dy)) { onCommit(preview || doc); setPreview(null); }
    else if (g.kind === 'move') setPreview(null);
    else if (g.kind === 'box' && box) {
      // left-to-right picks what is fully inside, right-to-left anything it touches (as in CAD tools)
      const picked = itemsIn(doc).filter(([, b]) => (box[4] ? hits(b, box) : inside(b, box))).map(([id]) => id);
      setSel(new Set([...(g.add ? sel : []), ...picked])); setBox(null);
    } else if (g.kind === 'pan' && g.right && !g.moved) {
      if (wire) finishWire();
      else if (tool !== 'select') setTool('select');
    }
  }
  function dbl(e) {
    if (tool === 'wire' || tool === 'bus') { finishWire(); return; }
    const id = e.target.closest?.('[data-id]')?.dataset.id;
    if (id) onOpenItem(id);
  }

  // ---------- keys ----------
  const copy = (ids) => {
    const set = new Set(ids), b = itemsIn(doc).filter(([id]) => set.has(id)).map(([, x]) => x);
    const ox = snap(Math.min(...b.map((x) => x[0]))), oy = snap(Math.min(...b.map((x) => x[1])));
    setClip({ parts: doc.parts.filter((p) => set.has(p.id)).map((p) => ({ ...clone(p), x: p.x - ox, y: p.y - oy })), wires: doc.wires.filter((w) => set.has(w.id)).map((w) => ({ ...clone(w), pts: w.pts.map(([x, y]) => [x - ox, y - oy]) })), labels: doc.labels.filter((l) => set.has(l.id)).map((l) => ({ ...l, x: l.x - ox, y: l.y - oy })) });
  };
  const keyRef = useRef(null);
  keyRef.current = (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const ids = [...sel];
    const partIds = ids.filter((id) => doc.parts.some((p) => p.id === id));
    if (k === 'escape') { if (wire) finishWire(); else if (tool !== 'select') setTool('select'); else setSel(new Set()); }
    else if (mod && k === 'z' && !e.shiftKey) onUndo();
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) onRedo();
    else if (mod && k === 'a') setSel(new Set(itemsIn(doc).map(([id]) => id)));
    else if (mod && k === 'd' && ids.length) commit((d) => setSel(new Set(sch.duplicate(d, ids, 20, 20, sheets))));
    else if (mod && k === 'c' && ids.length) copy(ids);
    else if (mod && k === 'x' && ids.length) { copy(ids); commit((d) => sch.removeItems(d, ids)); setSel(new Set()); }
    else if (mod && k === 'v' && clip) commit((d) => setSel(new Set(paste(d, clip, cursor[0], cursor[1], sheets))));
    else if (mod) return;
    else if (k === 'delete' || k === 'backspace') { if (ids.length) { commit((d) => sch.removeItems(d, ids)); setSel(new Set()); } }
    else if (k === 'r') { if (tool.startsWith('place:')) setGhostRot((r) => (r + (e.shiftKey ? 270 : 90)) % 360); else if (partIds.length) commit((d) => sch.turnParts(d, partIds, { rot: e.shiftKey ? 270 : 90 })); }
    else if (k === 'x' || k === 'm') { if (partIds.length) commit((d) => sch.turnParts(d, partIds, { mirror: true })); }
    else if (k === 'w') setTool('wire');
    else if (k === 'b') setTool('bus');
    else if (k === 'n' || k === 'l') setTool('net');
    else if (k === 't') setTool('text');
    else if (k === 'v' || k === 's') setTool('select');
    else if (k === 'f') fit();
    else if (k === '/' || k === ' ' && wire) setFlip((f) => !f);
    else if (k.startsWith('arrow') && ids.length) {
      const st = e.shiftKey ? 50 : 10, [dx, dy] = { arrowleft: [-st, 0], arrowright: [st, 0], arrowup: [0, -st], arrowdown: [0, st] }[k];
      commit((d) => moveSel(d, ids, dx, dy));
    } else return;
    e.preventDefault();
  };
  useEffect(() => {
    const kd = (e) => { if (e.key === ' ' && !/INPUT|TEXTAREA/.test(e.target.tagName)) { if (!wire) { setSpace(true); e.preventDefault(); } } keyRef.current(e); };
    const ku = (e) => { if (e.key === ' ') setSpace(false); };
    addEventListener('keydown', kd); addEventListener('keyup', ku);
    return () => { removeEventListener('keydown', kd); removeEventListener('keyup', ku); };
  }, [wire]);
  useEffect(() => { if (!tool.startsWith('place:')) setGhostRot(0); if (tool !== 'wire' && tool !== 'bus') setWire(null); }, [tool]);

  // ---------- status ----------
  const hoverInfo = useMemo(() => {
    if (!hover) return null;
    const p = shown.parts.find((x) => x.id === hover);
    if (p) return `${p.ref} · ${sch.symbolOf(p).name}${p.props?.value ? ` · ${p.props.value}` : ''}`;
    const w = shown.wires.find((x) => x.id === hover);
    if (w) { const i = conn.pointNet.get(ptKey(...w.pts[0])); return `${w.kind === 'bus' ? 'busbar' : 'wire'} · net ${i == null ? '?' : conn.nets[i].name}${i == null ? '' : ` (${conn.nets[i].nodes.length} pins)`}`; }
    const l = shown.labels.find((x) => x.id === hover);
    return l ? `${l.kind === 'net' ? 'net label' : 'text'} · ${l.text}` : null;
  }, [hover, shown, conn]);
  useEffect(() => { onStatus({ cursor, zone: sch.zoneOf(doc, ...cursor), hover: hoverInfo, issues, zoom: view?.k }); }, [cursor, hoverInfo, issues, view?.k]);

  // ---------- render ----------
  const hoverNet = useMemo(() => {
    const w = shown.wires.find((x) => x.id === hover);
    return w ? conn.pointNet.get(ptKey(...w.pts[0])) : null;
  }, [hover, shown, conn]);
  const frame = useMemo(() => sch.frameSvg(shown, C, project), [shown.size, shown.title, shown.name, shown.id, project, theme]);
  const xrefs = useMemo(() => sch.crossRefSvg(shown, sheets.map((s) => (s.id === shown.id ? shown : s)), C), [shown, sheets, theme]);
  const ghost = tool.startsWith('place:') ? { id: 'ghost', ref: sch.SYMBOLS[tool.slice(6)]?.prefix ? `${sch.SYMBOLS[tool.slice(6)].prefix}?` : '', sym: tool.slice(6), x: cursor[0], y: cursor[1], rot: ghostRot, props: { ...(sch.SYMBOLS[tool.slice(6)]?.props || {}) } } : null;
  const wirePreview = wire ? [...wire, ...elbow(wire.at(-1), cursor, flip)] : null;
  const v = view || { x: 0, y: 0, k: 1 };
  const gridStep = v.k < 0.45 ? 50 : 10;
  const cls = `canvas sch tool-${tool.split(':')[0]}${space || drag.current?.kind === 'pan' ? ' panning' : ''}${hover && tool === 'select' ? ' over' : ''}`;
  const selBoxes = itemsIn(shown).filter(([id]) => sel.has(id));
  const connected = new Set(conn.nets.flatMap((n) => n.points));
  return (
    <div className={cls}>
      <svg ref={svg} width="100%" height="100%" onPointerDown={down} onPointerMove={move} onPointerUp={up} onDoubleClick={dbl} onContextMenu={(e) => e.preventDefault()} style={{ background: theme === 'dark' ? '#0c0d11' : '#e9ebef' }}>
        <defs>
          <pattern id="grid" width={gridStep} height={gridStep} patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r={gridStep === 10 ? 0.7 : 1.2} fill={C.frame} opacity=".55" /></pattern>
        </defs>
        <g transform={`translate(${v.x} ${v.y}) scale(${v.k})`}>
          <g dangerouslySetInnerHTML={{ __html: frame }} />
          <rect x="20" y="20" width={W - 40} height={H - 40} fill="url(#grid)" pointerEvents="none" />
          {shown.wires.map((w) => (
            <g key={w.id} data-id={w.id} className="item">
              <polyline points={w.pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="transparent" strokeWidth={10 / Math.min(1, v.k)} />
              <g dangerouslySetInnerHTML={{ __html: sch.wireSvg(w, hoverNet != null && conn.pointNet.get(ptKey(...w.pts[0])) === hoverNet ? { ...C, wire: C.label, bus: C.label } : C) }} />
            </g>
          ))}
          {shown.parts.map((p) => {
            const b = sch.bboxOf(p);
            return (
              <g key={p.id} data-id={p.id} className="item">
                <rect x={b[0] - 3} y={b[1] - 3} width={b[2] - b[0] + 6} height={b[3] - b[1] + 6} fill="transparent" />
                <g dangerouslySetInnerHTML={{ __html: partMarkup(p, C, theme) }} />
                {sch.pinsOf(p).filter((q) => !connected.has(ptKey(q.x, q.y))).map((q) => <circle key={q.name} cx={q.x} cy={q.y} r="2.2" fill="none" stroke={C.pin} strokeWidth="1" pointerEvents="none" />)}
              </g>
            );
          })}
          {shown.labels.map((l) => <g key={l.id} data-id={l.id} className="item" dangerouslySetInnerHTML={{ __html: sch.labelSvg(l, C) }} />)}
          {conn.junctions.map(([x, y]) => <circle key={`${x},${y}`} cx={x} cy={y} r="3.2" fill={C.junction} pointerEvents="none" />)}
          <g dangerouslySetInnerHTML={{ __html: xrefs }} pointerEvents="none" />
          {selBoxes.map(([id, b]) => <rect key={id} className="selbox" x={b[0] - 5} y={b[1] - 5} width={b[2] - b[0] + 10} height={b[3] - b[1] + 10} rx="3" pointerEvents="none" />)}
          {ghost && sch.SYMBOLS[ghost.sym] && <g opacity=".55" pointerEvents="none" dangerouslySetInnerHTML={{ __html: sch.partSvg(ghost, C) }} />}
          {wirePreview && <polyline points={wirePreview.map((p) => p.join(',')).join(' ')} fill="none" stroke={C.wire} strokeWidth={tool === 'bus' ? 5 : 1.6} strokeDasharray="5 4" pointerEvents="none" />}
          {(tool === 'wire' || tool === 'bus' || tool === 'net' || tool === 'text') && <g pointerEvents="none" stroke={C.label} strokeWidth={1 / v.k}><path d={`M${cursor[0] - 8} ${cursor[1]}h16M${cursor[0]} ${cursor[1] - 8}v16`} /></g>}
          {box && <rect className={`boxsel ${box[4] ? 'cross' : ''}`} x={box[0]} y={box[1]} width={box[2] - box[0]} height={box[3] - box[1]} strokeWidth={1 / v.k} pointerEvents="none" />}
        </g>
      </svg>
      <div className="zoomctl">
        <button className="iconbtn" title="Zoom out" onClick={() => zoomBy(1 / 1.25)}>−</button>
        <button className="iconbtn zpct" title="Fit sheet (F)" onClick={fit}>{Math.round(v.k * 100)}%</button>
        <button className="iconbtn" title="Zoom in" onClick={() => zoomBy(1.25)}>+</button>
      </div>
    </div>
  );
}
