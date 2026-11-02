import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { store, Icon, useEscape } from './ui.jsx';
import { Editor } from './editor.jsx';
import { Palette, Toolbar, Inspector, ExportMenu, StatusBar } from './panels.jsx';
import * as sch from './schematic.js';
import './style.css';

const blobToB64 = (b) => new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result.split(',')[1]); r.readAsDataURL(b); });
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
async function readImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  let blob = file;
  if (k < 1 || file.size > 3.5e6) {
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
  }
  return { mime: blob.type, data: await blobToB64(blob), url: URL.createObjectURL(blob) };
}
const md = (t) => DOMPurify.sanitize(marked.parse(t || '', { breaks: true, gfm: true }));
const Logo = ({ s = 22 }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
    <rect width="24" height="24" rx="6" fill="var(--accent)" />
    <path d="M13.5 3.5 6.5 13h5l-1 7.5 7-9.5h-5z" fill="#fff" />
  </svg>
);
const toolIcon = (n) => (/^(edit_sheet|new_sheet|delete_sheet|set_project)$/.test(n) ? 'pen' : /^(get_sheet|list_sheets|list_symbols|snapshot|get_netlist|get_bom)$/.test(n) ? 'eye'
  : /^(Write|Edit|MultiEdit|Read|export)$/.test(n) ? 'file' : /^Bash$/.test(n) ? 'term' : /^(Grep|Glob|WebSearch|WebFetch|ToolSearch)$/.test(n) ? 'search' : 'tool');
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(t).toLocaleDateString(); };
const sysDark = () => { try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; } };
const EXAMPLES = [
  'Draw a DOL motor starter: 3-phase power circuit with breaker, contactor and motor, plus the 24VDC control circuit with stop/start and seal-in',
  'Draw a single-line diagram of a 10 kW PV system with a battery, a hybrid inverter, an energy meter and the grid connection',
  'Check this sheet: list unconnected pins and fix what you can',
];

function App() {
  const ws = useRef(null);
  const [hello, setHello] = useState({ sessions: [], cwd: '' });
  const [sess, setSess] = useState(null);
  const [sheets, setSheets] = useState([]);
  const [docs, setDocs] = useState({});
  const docsRef = useRef({}); docsRef.current = docs;
  const [project, setProjectState] = useState({});
  const [active, setActive] = useState(null);
  const [tool, setTool] = useState('select');
  const [sel, setSel] = useState(new Set());
  const [clip, setClip] = useState(null);
  const [chat, setChat] = useState([]);
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState(false);
  const [toast, setToast] = useState(null);
  const [status, setStatus] = useState({});
  const [showIssues, setShowIssues] = useState(0);
  const [theme, setTheme] = useState(() => store.get('vb-theme') || (sysDark() ? 'dark' : 'light'));
  const [leftW, setLeftW] = useState(() => +store.get('vb-leftW') || 400);
  const [chatOpen, setChatOpen] = useState(() => store.get('vb-chatOpen') !== '0');
  const [unseen, setUnseen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [sessErr, setSessErr] = useState(null);
  const chatOpenRef = useRef(true); chatOpenRef.current = chatOpen;
  const activeRef = useRef(null); activeRef.current = active;
  const tx = (m) => ws.current?.readyState === 1 && ws.current.send(JSON.stringify(m));

  // undo history and save state per sheet
  const hist = useRef({}); // id -> { past: [], future: [] }
  const sync = useRef({}); // id -> { base, inflight, dirty, timer }
  const H = (id) => (hist.current[id] ||= { past: [], future: [] });
  const S = (id) => (sync.current[id] ||= { base: docsRef.current[id]?.rev ?? 0, inflight: false, dirty: false });
  const [, bump] = useState(0);
  const flush = (id) => {
    const st = S(id);
    if (st.inflight) { st.dirty = true; return; }
    const doc = docsRef.current[id];
    if (!doc) return;
    st.inflight = true; st.dirty = false;
    tx({ t: 'sheet', doc, baseRev: st.base });
  };
  const queue = (id) => { const st = S(id); clearTimeout(st.timer); st.timer = setTimeout(() => flush(id), 250); };
  const setDoc = (id, doc) => { docsRef.current = { ...docsRef.current, [id]: doc }; setDocs(docsRef.current); };
  const commit = (next) => {
    const id = next.id, h = H(id);
    h.past.push(docsRef.current[id]); if (h.past.length > 200) h.past.shift();
    h.future = [];
    setDoc(id, next); queue(id);
  };
  const edit = (fn) => { const id = activeRef.current, d = structuredClone(docsRef.current[id]); fn(d); commit(d); };
  const undo = () => { const id = activeRef.current, h = H(id); if (!h.past.length) return; h.future.push(docsRef.current[id]); setDoc(id, h.past.pop()); queue(id); bump((x) => x + 1); };
  const redo = () => { const id = activeRef.current, h = H(id); if (!h.future.length) return; h.past.push(docsRef.current[id]); setDoc(id, h.future.pop()); queue(id); bump((x) => x + 1); };
  const say = (text) => { setToast(text); clearTimeout(say.t); say.t = setTimeout(() => setToast(null), 5000); };

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const toggleChat = () => { const o = !chatOpenRef.current; setChatOpen(o); store.set('vb-chatOpen', o ? '1' : '0'); if (o) setUnseen(false); };
  const toggleChatRef = useRef(toggleChat); toggleChatRef.current = toggleChat;
  useEffect(() => {
    const key = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === '\\') { e.preventDefault(); toggleChatRef.current(); } };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  }, []);

  function loadSheets(list, all, goto) {
    // keep local edits that are newer than what the server sent
    const next = {};
    for (const t of list) {
      const local = docsRef.current[t.id], st = sync.current[t.id];
      const keep = local && st && (st.inflight || st.dirty || st.base >= all[t.id].rev);
      next[t.id] = keep ? local : all[t.id];
      if (!keep) S(t.id).base = all[t.id].rev;
    }
    docsRef.current = next; setDocs(next); setSheets(list);
    setActive((a) => (goto != null && next[goto] ? goto : next[a] ? a : list[0]?.id ?? null));
  }

  function onMsg(m) {
    if (!chatOpenRef.current && /^(user|delta|tool|error|done)$/.test(m.t)) setUnseen(true);
    if (m.t === 'hello') { setHello(m); setConn(true); tx({ t: 'open', name: store.get('vb-session') || 'default' }); }
    else if (m.t === 'sessions') { setHello((h) => ({ ...h, sessions: m.sessions })); setSessErr(null); }
    else if (m.t === 'renamed') { setSess((x) => ({ ...x, name: m.to })); store.set('vb-session', m.to); }
    else if (m.t === 'deleted') { store.set('vb-session', m.next); tx({ t: 'open', name: m.next }); }
    else if (m.t === 'session') {
      hist.current = {}; sync.current = {}; docsRef.current = {};
      setSess(m); setProjectState(m.project || {}); setBusy(m.busy); setSel(new Set()); setTool('select');
      store.set('vb-session', m.name);
      loadSheets(m.sheets, m.docs);
      setActive(m.sheets[0]?.id ?? null);
      setChat(m.history.map((h) => (h.role === 'tool' ? { role: 'tool', name: h.name, state: 'ok' } : h)));
    } else if (m.t === 'sheets') { setProjectState(m.project || {}); loadSheets(m.sheets, m.docs, m.goto); }
    else if (m.t === 'ack') { const st = S(m.id); st.base = m.rev; st.inflight = false; if (st.dirty) flush(m.id); }
    else if (m.t === 'sheet') {
      const id = m.doc.id, st = S(id);
      if (m.conflict) { st.inflight = false; st.dirty = false; say('This sheet was changed elsewhere (Claude or another window); your last edit was replaced. Ctrl+Z brings it back.'); }
      const cur = docsRef.current[id];
      if (cur) { const h = H(id); h.past.push(cur); h.future = []; } // so Ctrl+Z undoes Claude's change too
      st.base = m.doc.rev;
      setDoc(id, m.doc);
      if (m.by === 'claude' && id !== activeRef.current) setActive(id);
      setSel((s) => { const all = new Set([...m.doc.parts, ...m.doc.wires, ...m.doc.labels].map((x) => x.id)); return new Set([...s].filter((x) => all.has(x))); });
    } else if (m.t === 'outDir') setSess((x) => ({ ...x, outDir: m.outDir }));
    else if (m.t === 'exported') say(`Wrote ${m.files.join(', ')}`);
    else if (m.t === 'user') setChat((c) => [...c, { role: 'user', text: m.text, images: m.images }]);
    else if (m.t === 'delta') setChat((c) => (c.at(-1)?.role === 'assistant' ? [...c.slice(0, -1), { role: 'assistant', text: c.at(-1).text + m.text }] : [...c, { role: 'assistant', text: m.text }]));
    else if (m.t === 'tool') { setBusy(true); setChat((c) => [...c, { role: 'tool', id: m.id, name: m.name, input: m.input, state: 'run' }]); }
    else if (m.t === 'tool_done') setChat((c) => c.map((x) => (x.id === m.id ? { ...x, state: m.error ? 'err' : 'ok' } : x)));
    else if (m.t === 'error') { if (m.for === 'renameSession' || m.for === 'deleteSession') setSessErr(m.text); else setChat((c) => [...c, { role: 'error', text: m.text }]); }
    else if (m.t === 'done') { setBusy(false); setChat((c) => c.map((x) => (x.state === 'run' ? { ...x, state: 'ok' } : x))); }
  }
  const onMsgRef = useRef(onMsg); onMsgRef.current = onMsg;
  useEffect(() => {
    let dead = false;
    const connect = () => {
      const w = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      w.onmessage = (e) => onMsgRef.current(JSON.parse(e.data));
      w.onclose = () => { setConn(false); if (!dead) setTimeout(connect, 2000); };
      ws.current = w;
    };
    connect();
    return () => { dead = true; ws.current.close(); };
  }, []);
  useEffect(() => {
    const report = (e) => fetch('/client-error', { method: 'POST', body: String(e.error?.stack || e.reason?.stack || e.message || e.reason) }).catch(() => {});
    addEventListener('error', report); addEventListener('unhandledrejection', report);
    return () => { removeEventListener('error', report); removeEventListener('unhandledrejection', report); };
  }, []);

  function startDrag(e) {
    const el = e.currentTarget, left = el.previousElementSibling.getBoundingClientRect().left;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
    const w = (ev) => Math.round(Math.max(300, Math.min(innerWidth * 0.6, ev.clientX - left)));
    const move = (ev) => setLeftW(w(ev));
    const up = (ev) => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); document.body.classList.remove('dragging'); store.set('vb-leftW', w(ev)); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  }

  const doc = docs[active];
  const allDocs = useMemo(() => sheets.map((t) => docs[t.id]).filter(Boolean), [sheets, docs]);
  const setProject = (fields) => { setProjectState((p) => ({ ...p, ...fields })); tx({ t: 'project', fields }); };
  const act = (a) => {
    const ids = [...sel], parts = ids.filter((id) => doc.parts.some((p) => p.id === id));
    if (a === 'undo') undo(); else if (a === 'redo') redo();
    else if (a === 'rotate' && parts.length) edit((d) => sch.turnParts(d, parts, { rot: 90 }));
    else if (a === 'mirror' && parts.length) edit((d) => sch.turnParts(d, parts, { mirror: true }));
    else if (a === 'delete' && ids.length) { edit((d) => sch.removeItems(d, ids)); setSel(new Set()); }
  };
  const theme_ = () => { const t = theme === 'dark' ? 'light' : 'dark'; setTheme(t); store.set('vb-theme', t); };
  const h = active != null ? H(active) : { past: [], future: [] };
  const sendChat = (text, images) => tx({ t: 'chat', text, images, sheet: active, selection: [...sel].map((id) => { const p = doc?.parts.find((x) => x.id === id); return p ? `${p.ref} (${p.id}, ${p.sym})` : id; }) });

  return (
    <div className="app">
      <header className="top">
        <button className={`iconbtn chattoggle ${chatOpen ? 'on' : ''}`} onClick={toggleChat} title="Show/hide chat (Ctrl+\)" aria-label="Toggle chat">
          <Icon n="panel" s={17} />{!chatOpen && (busy || unseen) && <span className={`ind ${busy ? 'busy' : ''}`} />}
        </button>
        <Logo /><span className="brand">voltbridge</span><span className="slash">/</span>
        <SessionPicker hello={hello} sess={sess} tx={tx} err={sessErr} setErr={setSessErr} />
        {!hello.user && <span className="cwd" title={sess?.cwd}>{sess?.cwd}</span>}
        <span className="grow" />
        <span className={`conn ${conn ? 'on' : ''}`}>{conn ? 'connected' : 'offline'}</span>
        {hello.user && <button className="linkbtn" title={`Signed in as ${hello.user}`} onClick={() => fetch('/auth/logout', { method: 'POST' }).then(() => location.reload())}>Sign out</button>}
        <button className="iconbtn" onClick={theme_} title="Light / dark"><Icon n={theme === 'dark' ? 'sun' : 'moon'} s={17} /></button>
      </header>
      <div className="main">
        <section className={`left ${chatOpen ? '' : 'hidden'}`} style={{ width: leftW }}>
          <Chat chat={chat} busy={busy} onExample={setDraft} ai={hello.assistant || 'Claude'} />
          <Composer ai={hello.assistant || 'Claude'} busy={busy} send={sendChat} stop={() => tx({ t: 'stop' })} draft={draft} clearDraft={() => setDraft(null)} />
        </section>
        {chatOpen && <div className="splitter" onPointerDown={startDrag} />}
        <section className="right">
          <SheetTabs sheets={sheets} docs={docs} active={active} setActive={(id) => { setActive(id); setSel(new Set()); }} tx={tx} edit={(id, fn) => { const d = structuredClone(docsRef.current[id]); fn(d); commit(d); }}>
            {doc && <ExportMenu doc={doc} sheets={allDocs} project={project} sessName={sess?.name || 'project'} tx={tx} />}
          </SheetTabs>
          {doc ? <>
            <Toolbar tool={tool} setTool={setTool} hasSel={sel.size > 0} act={act} canUndo={h.past.length > 0} canRedo={h.future.length > 0} />
            <div className="work">
              <Palette tool={tool} setTool={setTool} theme={theme} />
              <Editor doc={doc} sheets={allDocs} project={project} theme={theme} tool={tool} setTool={setTool} sel={sel} setSel={setSel}
                onCommit={(d) => { commit(d); bump((x) => x + 1); }} onUndo={undo} onRedo={redo} onStatus={setStatus} onOpenItem={(id) => setSel(new Set([id]))}
                clip={clip} setClip={setClip} ask={async (q) => prompt(q)} />
              <Inspector doc={doc} sheets={allDocs} sel={sel} setSel={setSel} edit={edit} project={project} setProject={setProject} showIssues={showIssues} />
            </div>
            <StatusBar st={status} tool={tool} onIssues={() => { setSel(new Set()); setShowIssues((x) => x + 1); }} />
          </> : <div className="pempty">No sheets. Press + to add one.</div>}
          {toast && <div className="toast" role="status">{toast}</div>}
        </section>
      </div>
    </div>
  );
}

function SheetTabs({ sheets, docs, active, setActive, tx, edit, children }) {
  const [editing, setEditing] = useState(null);
  const [dragId, setDragId] = useState(null);
  return (
    <div className="tabbar">
      <div className="tabstrip">
        {sheets.map((t, i) => {
          const d = docs[t.id];
          if (!d) return null;
          return editing === t.id ? (
            <div key={t.id} className="tab on"><input autoFocus defaultValue={d.name} onFocus={(e) => e.target.select()}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== d.name) edit(t.id, (x) => { x.name = v; }); setEditing(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEditing(null); }} /></div>
          ) : (
            <div key={t.id} className={`tab ${t.id === active ? 'on' : ''}`} onClick={() => setActive(t.id)} onDoubleClick={() => setEditing(t.id)} title={`${d.name} — double-click to rename, drag to reorder`}
              draggable onDragStart={() => setDragId(t.id)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragId != null && dragId !== t.id) tx({ t: 'moveSheet', id: dragId, index: i }); setDragId(null); }}>
              <span className="tnum">{t.id}</span><span className="tname">{d.name}</span>
              <button className="tclose" title="Delete sheet" aria-label={`Delete sheet ${d.name}`} onClick={(e) => { e.stopPropagation(); if (confirm(`Delete sheet "${d.name}"?`)) tx({ t: 'deleteSheet', id: t.id }); }}><Icon n="x" s={12} /></button>
            </div>
          );
        })}
      </div>
      <button className="iconbtn" title="New sheet" aria-label="New sheet" onClick={() => tx({ t: 'newSheet' })}><Icon n="plus" s={15} /></button>
      <span className="grow" />
      {children}
    </div>
  );
}

function SessionPicker({ hello, sess, tx, err, setErr }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [edit, setEdit] = useState(null);
  const show = () => { tx({ t: 'list' }); setOpen(true); };
  const close = () => { setOpen(false); setEdit(null); setErr(null); };
  const go = (n, dir) => { tx({ t: 'open', name: n, cwd: dir }); close(); setName(''); };
  const valid = (v) => /^[\w.-]{1,64}$/.test(v) && !/^\.+$/.test(v);
  const local = edit && (!valid(edit.value) ? 'Use 1-64 letters, digits, dot, dash or underscore.' : null);
  const save = () => { if (local) return; if (edit.value === edit.from) { setEdit(null); return; } tx({ t: 'renameSession', from: edit.from, to: edit.value }); };
  useEffect(() => { if (edit && edit.value !== edit.from && hello.sessions.some((x) => x.name === edit.value)) setEdit(null); }, [hello.sessions]);
  useEscape(open && !edit, close);
  return (
    <div className="picker">
      <button className="sessbtn" onClick={() => (open ? close() : show())} aria-expanded={open}>{sess?.name || '...'} <Icon n="chev" s={14} /></button>
      {open && <>
        <div className="scrim" onClick={close} />
        <div className="pop" role="dialog" aria-label="Projects">
          <div className="pophead">Projects</div>
          <div className="plist">
            {hello.sessions.length === 0 && <div className="muted pad">No saved projects yet.</div>}
            {hello.sessions.map((x) => (edit?.from === x.name ? (
              <div key={x.name} className="prow editing">
                <input autoFocus value={edit.value} onFocus={(e) => e.target.select()} onChange={(e) => { setEdit({ ...edit, value: e.target.value }); setErr(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEdit(null); } }} />
                {(local || err) && <div className="perr" role="alert">{local || err}</div>}
              </div>
            ) : (
              <div key={x.name} className={`prow sess ${x.name === sess?.name ? 'on' : ''}`}>
                <button className="pname" onClick={() => go(x.name)}><span>{x.name}</span><span className="muted">{x.sheets} sheet{x.sheets === 1 ? '' : 's'} · {ago(x.mtime)}</span></button>
                <button className="iconbtn picon" title="Rename" onClick={() => setEdit({ from: x.name, value: x.name })}><Icon n="pen" s={13} /></button>
                <button className="iconbtn picon del" title="Delete" onClick={() => { if (confirm(`Delete project '${x.name}' and all its sheets?`)) tx({ t: 'deleteSession', name: x.name }); }}><Icon n="trash" s={13} /></button>
              </div>
            )))}
            {err && !edit && <div className="perr pad" role="alert">{err}</div>}
          </div>
          <form className="pnew" onSubmit={(e) => { e.preventDefault(); if (name.trim()) go(name.trim(), cwd.trim() || undefined); }}>
            <div className="pophead">New project</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (letters, digits, . _ -)" pattern="[\w.\-]{1,64}" required />
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={`working folder (default ${hello.cwd})`} />
            <button className="primary" type="submit">Create</button>
          </form>
        </div>
      </>}
    </div>
  );
}

function Chat({ chat, busy, onExample, ai }) {
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [chat, busy]);
  const groups = [];
  for (const c of chat) {
    if (c.role === 'tool' && groups.at(-1)?.role === 'tools') groups.at(-1).items.push(c);
    else groups.push(c.role === 'tool' ? { role: 'tools', items: [c] } : c);
  }
  const streaming = busy && chat.at(-1)?.role === 'assistant';
  return (
    <div className="chat">
      {chat.length === 0 && (
        <div className="hero">
          <Logo s={40} />
          <h2>Draw schematics with {ai}</h2>
          <p>Ask {ai} to draw or check a circuit, or paste a photo of a schematic to make it editable. You can edit everything by hand too.</p>
          <div className="examples">{EXAMPLES.map((x) => <button key={x} onClick={() => onExample(x)}>{x}</button>)}</div>
        </div>
      )}
      {groups.map((g, i) => (g.role === 'tools' ? (
        <div key={i} className="chips">{g.items.map((c, j) => (
          <details key={j} className={`chip ${c.state}`}>
            <summary><Icon n={toolIcon(c.name)} s={13} /><span>{c.name}</span>{c.state === 'run' ? <span className="spin" /> : <Icon n={c.state === 'err' ? 'x' : 'check'} s={12} />}</summary>
            {c.input && <pre>{c.input}</pre>}
          </details>))}
        </div>
      ) : g.role === 'user' ? (
        <div key={i} className="msg user">
          {g.images?.length > 0 && <div className="imgs">{g.images.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt="pasted" /></a>)}</div>}
          {g.text}
        </div>
      ) : g.role === 'error' ? (
        <div key={i} className="msg error"><Icon n="alert" s={14} /> {g.text}</div>
      ) : (
        <Markdown key={i} text={g.text} live={streaming && i === groups.length - 1} />
      )))}
      {busy && !streaming && <div className="typing" aria-label={`${ai} is working`}><i /><i /><i /></div>}
      <div ref={end} />
    </div>
  );
}
function Markdown({ text, live }) {
  const html = useMemo(() => md(text), [text]);
  return <div className={`msg assistant md ${live ? 'live' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Composer({ ai, busy, send: sendMsg, stop, draft, clearDraft }) {
  const [input, setInput] = useState('');
  const [imgs, setImgs] = useState([]);
  const [drag, setDrag] = useState(false);
  const ta = useRef(null);
  const file = useRef(null);
  useEffect(() => { if (draft) { setInput(draft); clearDraft(); ta.current?.focus(); } }, [draft]);
  useEffect(() => { const el = ta.current; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 220)}px`; }, [input]);
  async function addImages(files) { const ok = [...files].filter((f) => IMG_TYPES.includes(f.type)); const read = await Promise.all(ok.map(readImage)); setImgs((cur) => [...cur, ...read]); }
  function send() {
    if ((!input.trim() && !imgs.length) || busy) return;
    sendMsg(input, imgs.map(({ mime, data }) => ({ mime, data })));
    setInput(''); setImgs([]);
  }
  const files = (e) => e.dataTransfer?.types?.includes('Files');
  return (
    <div className={`composer ${drag ? 'drag' : ''}`}
      onDragEnter={(e) => { if (files(e)) { e.preventDefault(); setDrag(true); } }} onDragOver={(e) => { if (files(e)) e.preventDefault(); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false); }} onDrop={(e) => { e.preventDefault(); setDrag(false); addImages(e.dataTransfer.files); }}>
      {drag && <div className="dropzone">Drop image to attach</div>}
      {imgs.length > 0 && <div className="pending">{imgs.map((im, i) => (
        <span key={im.url} className="thumb"><img src={im.url} alt="attachment" /><button title="Remove" onClick={() => setImgs(imgs.filter((_, j) => j !== i))}><Icon n="x" s={11} /></button></span>))}</div>}
      <textarea ref={ta} rows={1} value={input} onChange={(e) => setInput(e.target.value)} placeholder={`Ask ${ai} to draw, check or explain a circuit...`}
        onPaste={(e) => { if ([...e.clipboardData.files].some((f) => IMG_TYPES.includes(f.type))) { e.preventDefault(); addImages(e.clipboardData.files); } }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
      <div className="cbar">
        <button className="iconbtn" title="Attach image" onClick={() => file.current.click()}><Icon n="clip" /></button>
        <input ref={file} type="file" accept={IMG_TYPES.join(',')} multiple hidden onChange={(e) => { addImages(e.target.files); e.target.value = ''; }} />
        <span className="hint">Enter to send · {ai} sees the open sheet and your selection</span>
        {busy ? <button className="sendbtn stop" onClick={stop} title="Stop"><Icon n="stop" /></button>
          : <button className="sendbtn" onClick={send} disabled={!input.trim() && !imgs.length} title="Send"><Icon n="send" /></button>}
      </div>
    </div>
  );
}

class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) { fetch('/client-error', { method: 'POST', body: String(err.stack || err) }).catch(() => {}); }
  render() { return this.state.err ? <pre className="crash">{String(this.state.err.stack || this.state.err)}</pre> : this.props.children; }
}
createRoot(document.getElementById('root')).render(<Boundary><App /></Boundary>);
