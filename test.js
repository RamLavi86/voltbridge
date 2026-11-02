// Quick checks of the schematic model, sessions and Claude's tools. Run: npm test (writes test-out/*.png to look at).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voltbridge-test-'));
process.env.VOLTBRIDGE_SESSIONS = path.join(tmp, 'sessions');
const lib = await import('./lib.js');
const sch = await import('./web/schematic.js');

let n = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { n++; console.log('ok', name); }, (e) => { console.error('FAIL', name, '\n', e); process.exitCode = 1; });

// every pin of every symbol is on the grid, in every orientation
await ok('pins on grid', () => {
  for (const key of Object.keys(sch.SYMBOLS)) for (const rot of [0, 90, 180, 270]) for (const mirror of [false, true]) {
    const p = { id: 'p', ref: 'X', sym: key, x: 100, y: 100, rot, mirror, props: {} };
    for (const q of sch.pinsOf(p)) assert.ok(q.x % 10 === 0 && q.y % 10 === 0, `${key} rot ${rot} pin ${q.name} at ${q.x},${q.y}`);
    sch.partSvg(p);
  }
});

const s = lib.openSession('t1', tmp);
const doc = s.docs[1];
const events = [];
const ctx = { sheetChanged: (d) => events.push(['sheet', d.id]), sheetsChanged: () => events.push(['sheets']), exported: () => {} };
const tools = Object.fromEntries(lib.makeTools(s, ctx).map((t) => [t.name, t]));
const call = async (name, args) => { const r = await tools[name].handler(args, {}); if (r.isError) throw new Error(r.content[0].text); return r.content[0].type === 'text' ? JSON.parse(r.content[0].text) : r.content[0]; };

// a DOL motor starter: power circuit on the left, control circuit on the right
await ok('draw a motor starter', async () => {
  const r = await call('edit_sheet', { sheet: '1', ops: [
    { op: 'sheet', name: 'Motor starter', title: { title: 'DOL starter M1', drawingNo: 'E-001', rev: 'A', author: 'voltbridge' } },
    { op: 'wire', pts: [[80, 100], [860, 100]] }, { op: 'label', text: 'L1', x: 80, y: 100 },
    { op: 'wire', pts: [[80, 120], [700, 120]] }, { op: 'label', text: 'L2', x: 80, y: 120 },
    { op: 'wire', pts: [[80, 140], [700, 140]] }, { op: 'label', text: 'L3', x: 80, y: 140 },
    { op: 'add', sym: 'breaker_3p', x: 260, y: 220, props: { value: 'C16 3P' } },
    { op: 'add', sym: 'contactor_3p', ref: 'K1', x: 260, y: 340 },
    { op: 'add', sym: 'motor_3p', x: 260, y: 480 },
    { op: 'connect', from: 'L1:x', to: 'Q1:1' },
  ] }).catch((e) => ({ errors: [e.message] }));
  assert.ok(r.errors.length === 1, 'connect to a label is not a pin'); // L1:x is not a part
  const r2 = await call('edit_sheet', { sheet: 'Motor starter', ops: [
    { op: 'wire', pts: [[240, 100], [240, 190]] }, { op: 'wire', pts: [[260, 120], [260, 190]] }, { op: 'wire', pts: [[280, 140], [280, 190]] },
    { op: 'connect', from: 'Q1:2', to: 'K1:1' }, { op: 'connect', from: 'Q1:4', to: 'K1:3' }, { op: 'connect', from: 'Q1:6', to: 'K1:5' },
    { op: 'connect', from: 'K1:2', to: 'M1:U' }, { op: 'connect', from: 'K1:4', to: 'M1:V' }, { op: 'connect', from: 'K1:6', to: 'M1:W' },
    { op: 'add', sym: 'pe', x: 300, y: 420, rot: 180 },
    // control: L1 -> F2 -> S1 (stop) -> S2 (start) || K1 13-14 -> K1 coil -> N
    { op: 'add', sym: 'fuse', x: 760, y: 170 },
    { op: 'add', sym: 'push_nc', x: 760, y: 250 },
    { op: 'add', sym: 'push_no', x: 760, y: 330 },
    { op: 'add', sym: 'contact_no', ref: 'K1', x: 840, y: 330 },
    { op: 'add', sym: 'coil', ref: 'K1', x: 760, y: 430 },
    { op: 'add', sym: 'rail', x: 760, y: 510, rot: 180, props: { net: 'N' } },
    { op: 'connect', from: 'F1:2', to: 'S1:11' }, { op: 'connect', from: 'S1:12', to: 'S2:13' }, { op: 'connect', from: 'S2:14', to: 'K1:A1' },
    { op: 'connect', from: [760, 290], to: 'K1:13', via: [[840, 290]] }, { op: 'connect', from: 'K1:14', to: [760, 370], via: [[840, 370]] },
    { op: 'wire', pts: [[760, 100], [760, 140]] },
    { op: 'connect', from: 'K1:A2', to: 'N:1' },
  ] });
  assert.deepEqual(r2.errors, []);
  const nets = sch.connectivity(doc).nets;
  const net = (node) => nets.find((x) => x.nodes.includes(node));
  assert.equal(net('Q1:1').name, 'L1');
  assert.equal(net('Q1:2'), net('K1:1'));
  assert.equal(net('K1:2'), net('M1:U'));
  assert.equal(net('S2:14'), net('K1:A1'));
  assert.equal(net('K1:14'), net('K1:A1'), 'seal-in contact parallels the start button');
  assert.equal(net('S1:12'), net('K1:13'));
  assert.equal(net('F1:1').name, 'L1');
  assert.equal(net('K1:A2').name, 'N');
  const bom = sch.bom([doc]);
  assert.deepEqual(bom.map((b) => b.refs.join(' ')), ['F1', 'K1', 'M1', 'Q1', 'S1', 'S2']);
  const xr = sch.crossRefs([doc]);
  assert.equal(xr.K1.contacts.length, 2);
});

await ok('moving a part drags its wires', async () => {
  const before = sch.findPin(doc, 'M1:U');
  await call('edit_sheet', { sheet: '1', ops: [{ op: 'update', ref: 'M1', x: 300, y: 500 }] });
  const nets = sch.connectivity(doc).nets;
  assert.equal(nets.find((x) => x.nodes.includes('K1:2')), nets.find((x) => x.nodes.includes('M1:U')));
  assert.notDeepEqual(before, sch.findPin(doc, 'M1:U'));
  for (const w of doc.wires) for (let i = 1; i < w.pts.length; i++) assert.ok(w.pts[i][0] === w.pts[i - 1][0] || w.pts[i][1] === w.pts[i - 1][1], `${w.id} stays orthogonal`);
});

await ok('get_sheet, netlist, bom, ambiguous refs', async () => {
  const g = await call('get_sheet', { sheet: '1' });
  assert.ok(g.parts.find((p) => p.ref === 'Q1').pins['1'].net === 'L1');
  await assert.rejects(call('edit_sheet', { sheet: '1', ops: [{ op: 'delete', ref: 'K1' }] }), /use the id/);
  assert.ok((await call('get_netlist', {})).some((x) => x.name === 'L1'));
  assert.ok((await call('get_bom', {})).length === 6);
});

await ok('single-line diagram on a second sheet, block symbol', async () => {
  const d = await call('new_sheet', { name: 'Single line' });
  const r = await call('edit_sheet', { sheet: String(d.id), ops: [
    { op: 'add', sym: 'pv_module', x: 200, y: 160, props: { value: '12 x 400W' } },
    { op: 'add', sym: 'disconnector', x: 200, y: 280, props: { value: 'DC 1000V' } },
    { op: 'add', sym: 'inverter', x: 200, y: 400, props: { value: '10kW' } },
    { op: 'add', sym: 'breaker', x: 200, y: 530, props: { value: 'C20 4P' } },
    { op: 'wire', pts: [[100, 600], [500, 600]], kind: 'bus' },
    { op: 'add', sym: 'energy_meter', x: 400, y: 680 },
    { op: 'add', sym: 'grid', x: 400, y: 790, rot: 180 },
    { op: 'add', sym: 'block', x: 800, y: 300, props: { label: 'PLC', left: 'DI1,DI2,DI3', right: 'DO1,DO2' } },
    { op: 'connect', from: 'G1:+', to: 'Q2:1' }, { op: 'connect', from: 'Q2:2', to: 'U1:DC' }, { op: 'connect', from: 'U1:AC', to: 'Q3:1' },
    { op: 'connect', from: 'Q3:2', to: [200, 600] }, { op: 'connect', from: [400, 600], to: 'P1:1' }, { op: 'connect', from: 'P1:2', to: 'G2:1' },
  ] });
  assert.deepEqual(r.errors, []);
  const nets = sch.connectivity(s.docs[d.id]).nets;
  assert.equal(nets.find((x) => x.nodes.includes('Q3:2')), nets.find((x) => x.nodes.includes('P1:1')), 'bus joins both');
});

await ok('snapshot and exports render', async () => {
  const img = await call('snapshot', { sheet: '1' });
  assert.equal(img.type, 'image');
  fs.mkdirSync('test-out', { recursive: true });
  fs.writeFileSync('test-out/sheet1.png', Buffer.from(img.data, 'base64'));
  const img2 = await call('snapshot', { sheet: '2' });
  fs.writeFileSync('test-out/sheet2.png', Buffer.from(img2.data, 'base64'));
  s.outDir = path.join(tmp, 'out');
  for (const f of ['svg', 'bom', 'netlist', 'json']) assert.ok((await call('export', { format: f })).length >= 1);
});

await ok('house main board: multi-pole, poles marking, array, circuits, prefixes, RTL', async () => {
  const d = await call('new_sheet', { name: 'Main board' });
  const sh = String(d.id);
  const r = await call('edit_sheet', { sheet: sh, ops: [
    { op: 'sheet', refPrefix: '=MDB1', title: { title: 'לוח ראשי 3x400/230V' } },
    { op: 'rect', x: 60, y: 60, w: 1100, h: 680, text: 'לוח ראשי MDB-01' },
    { op: 'add', sym: 'grid', x: 160, y: 90, props: { value: 'רשת 3x400/230V' } },
    { op: 'add', sym: 'switch_disconnector_4p', ref: 'Q1', x: 160, y: 200, props: { value: '63A' } },
    { op: 'add', sym: 'rcd_4p', x: 160, y: 300, props: { value: '40A 30mA' } },
    { op: 'add', sym: 'rcd', x: 400, y: 300, props: { poles: '4', value: '40A 30mA SLD' } },
    { op: 'connect', from: 'G1:1', to: 'Q1:3' },
    { op: 'wire', pts: [[120, 400], [1000, 400]], kind: 'bus', label: 'L1 L2 L3 N' },
    { op: 'connect', from: 'Q2:4', to: [150, 400] },
    { op: 'array', count: 6, dx: 120, start: 1, ops: [
      { op: 'add', sym: 'breaker', x: 280, y: 470, props: { value: 'C16', circuit: 'C{i}', cable: '3x2.5mm2', length: '20', phase: 'L1', power: '2kW' } },
      { op: 'add', sym: 'socket', x: 280, y: 600, props: { ways: '2', description: 'שקעים {i}' } },
      { op: 'connect', from: [280, 400], to: '$0:1' },
      { op: 'connect', from: '$0:2', to: '$1:1' },
    ] },
    { op: 'add', sym: 'breaker', x: 1060, y: 470, props: { value: 'C25', poles: '3', circuit: 'C7', cable: 'NYY 5x6mm2', phase: 'L1L2L3', power: '9kW' } },
    { op: 'add', sym: 'water_heater', x: 1060, y: 600, props: { description: 'דוד חשמל' } },
    { op: 'connect', from: 'Q10:2', to: 'E1:1' },
    { op: 'table', auto: 'circuits', x: 60, y: 780, text: 'טבלת מעגלים' },
    { op: 'add', sym: 'n_bar', x: 700, y: 300, props: { ways: '4' } },
    { op: 'add', sym: 'pe_bar', x: 900, y: 300, props: { ways: '4' } },
    { op: 'add', sym: 'pv_array', x: 1300, y: 120 },
    { op: 'add', sym: 'hybrid_inverter', x: 1300, y: 300 },
    { op: 'add', sym: 'battery_storage', x: 1420, y: 120, rot: 180 },
    { op: 'connect', from: 'G2:1', to: 'U1:PV' }, { op: 'connect', from: 'G3:1', to: 'U1:BAT' },
  ] });
  assert.deepEqual(r.errors, []);
  const doc2 = s.docs[d.id];
  assert.equal(doc2.parts.filter((p) => p.sym === 'breaker').length, 7);
  assert.equal(sch.symbolOf(doc2.parts.find((p) => p.ref === 'Q2')).pins.length, 8, 'rcd_4p has 4 poles');
  assert.equal(sch.symbolOf(doc2.parts.find((p) => p.ref === 'Q3')).pins.length, 2, 'rcd with poles is single-line');
  const c = sch.circuits([doc2]);
  assert.equal(c.length, 7);
  assert.equal(c[0].circuit, 'C1'); assert.equal(c[0].load, 'שקעים 1', 'load found downstream');
  // Q1 here is =MDB1-Q1, not the Q1 of sheet 1; giving a taken ref in the same scope renumbers it
  const r2 = await call('edit_sheet', { sheet: sh, ops: [{ op: 'add', sym: 'breaker', ref: 'Q4', x: 1300, y: 600 }] });
  assert.match(r2.warnings[0], /Q4 is taken in =MDB1, used Q11/);
  assert.ok(sch.bom(lib.allSheets(s)).some((b) => b.refs.includes('=MDB1-Q1')) && sch.bom(lib.allSheets(s)).some((b) => b.refs.includes('Q1')));
  const issues = sch.check(doc2, lib.allSheets(s));
  assert.ok(!issues.some((x) => /more than one device/.test(x)), issues.join('\n'));
  assert.ok(issues.some((x) => /phase imbalance/.test(x)), 'all sockets on L1 ' + JSON.stringify(sch.phaseLoads(doc2)));
  // RTL text goes out in visual order with bidi-override
  const svg = sch.sheetSvg(doc2, lib.allSheets(s));
  assert.ok(svg.includes('3x400/230V תשר') && svg.includes('unicode-bidi="bidi-override"'));
  assert.ok(svg.includes('3x2.5mm²'));
  fs.writeFileSync('test-out/board.png', await lib.png(svg, 2400));
});

await ok('text overlap is reported', () => {
  const t = sch.emptySheet(9);
  sch.applyOps(t, [{ op: 'add', sym: 'breaker', x: 100, y: 100, props: { value: 'Sockets bath/laundry' } }, { op: 'add', sym: 'breaker', x: 160, y: 100 }]);
  assert.ok(sch.check(t).some((x) => /Q1 text "Sockets bath\/laundry" overlaps Q2/.test(x)), sch.check(t).join('\n'));
});

await ok('session round trip and revision conflicts', () => {
  lib.saveSession(s);
  const t = lib.openSession('t1', tmp);
  assert.equal(t.docs[1].parts.length, doc.parts.length);
  assert.equal(t.sheets.length, 3);
  const rev = t.docs[1].rev;
  assert.equal(lib.putSheet(t, { ...t.docs[1], parts: [] }, rev - 1), false);
  assert.equal(lib.putSheet(t, { ...t.docs[1], parts: [] }, rev), true);
  assert.equal(t.docs[1].rev, rev + 1);
});

// ---------- the API loop (ai.js) against a scripted fake OpenAI-style server ----------
const ai = await import('./ai.js');
const http = await import('node:http');

await ok('tool schemas: no property-less objects, free-form args as JSON strings', () => {
  const tl = ai.apiTools(lib.toolDefs(s, ctx));
  const walk = (n, where) => {
    if (n.type === 'object') { assert.ok(Object.keys(n.properties || {}).length, `${where}: object without properties`); for (const [k, v] of Object.entries(n.properties)) walk(v, `${where}.${k}`); }
    if (n.items) walk(n.items, `${where}[]`);
    assert.ok(!('additionalProperties' in n) && !('$schema' in n), `${where}: unsupported keyword`);
  };
  for (const t of tl) if (t.parameters) walk(t.parameters, t.name);
  const edit = tl.find((t) => t.name === 'edit_sheet');
  assert.equal(edit.parameters.properties.ops.type, 'string');
  assert.deepEqual(edit.parameters.required.sort(), ['ops', 'sheet']);
  assert.deepEqual(edit.decode({ sheet: '1', ops: '[{"op":"add","x":1}]' }).ops, [{ op: 'add', x: 1 }]);
  assert.equal(tl.find((t) => t.name === 'list_sheets').parameters, undefined, 'tools without arguments declare none');
});

const toolCtx = { sheetChanged() {}, sheetsChanged() {}, exported() {} };

await ok('symbol library as compact text', () => {
  const all = lib.symbolText();
  assert.match(all, /# Protection\n[^]*breaker_3p \| Circuit breaker, 3-pole \| Q \| 1@-20,-30 3@0,-30 5@20,-30 2@-20,30 4@0,30 6@20,30/);
  assert.ok(all.length < 6000, `library is ${all.length} chars`);
  assert.ok(!lib.symbolText('breaker').includes('resistor') && lib.symbolText('nope-x').startsWith('no symbol matches'));
  assert.match(lib.sheetsSummary(s), /sheets now: 1 "Motor starter" A3, \d+ parts; /);
});

const oneCall = (name, args, id) => [{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }];

await ok('agent loop sends only the newest copy of a repeated read, and the newest pasted image', async () => {
  const s3 = lib.openSession('t3', tmp);
  const fake = await fakeChat([
    oneCall('get_sheet', { sheet: '1' }, 'c1'),
    oneCall('edit_sheet', { sheet: '1', ops: '[{"op":"add","sym":"resistor","x":100,"y":100}]' }, 'c2'),
    oneCall('get_sheet', { sheet: '1' }, 'c3'),
  ]);
  fs.mkdirSync(path.join(tmp, 'img'), { recursive: true });
  for (const f of ['a.png', 'b.png']) fs.writeFileSync(path.join(tmp, 'img', f), 'x');
  const messages = [{ role: 'user', text: 'first', images: ['a.png'] }, { role: 'assistant', text: 'seen', calls: [] }, { role: 'user', text: 'second', images: ['b.png'] }];
  try {
    await ai.runAgent({ provider: fake.provider, system: 's', messages, tools: ai.apiTools(lib.toolDefs(s3, toolCtx)), imageDir: path.join(tmp, 'img') });
    const last = fake.bodies.at(-1).messages;
    const reads = last.filter((m) => m.role === 'tool' && ['c1', 'c3'].includes(m.tool_call_id)).map((m) => m.content);
    assert.equal(reads.length, 2);
    assert.match(reads[0], /^\(older result left out/);
    assert.ok(reads[1].includes('"parts"'), 'the latest read stays in full');
    const users = last.filter((m) => m.role === 'user');
    assert.ok(typeof users[0].content === 'string' && users[0].content.includes('not shown again'), 'older image is dropped');
    assert.ok(users[1].content.some((c) => c.type === 'image_url'), 'newest image is attached');
  } finally { fake.close(); }
});

await ok('agent loop drops the oldest turns past the history budget, never mid-turn', async () => {
  const fake = await fakeChat([[{ choices: [{ delta: { content: 'ok' } }] }]]);
  const big = 'x'.repeat(100000);
  const messages = [
    { role: 'user', text: big }, { role: 'assistant', text: 'a', calls: [{ id: 'c0', name: 'list_sheets', args: {} }] },
    { role: 'tool', results: [{ id: 'c0', name: 'list_sheets', text: 'r' }] }, { role: 'assistant', text: 'b', calls: [] },
    { role: 'user', text: 'recent question' },
  ];
  try {
    await ai.runAgent({ provider: fake.provider, system: 's', messages, tools: [], imageDir: tmp });
    const sent = fake.bodies[0].messages;
    assert.deepEqual(sent.map((m) => m.role), ['system', 'user'], 'only the recent turn is sent');
    assert.equal(sent[1].content, 'recent question');
    assert.equal(messages.length, 6, 'the stored transcript is untouched');
  } finally { fake.close(); }
});

// a fake OpenAI-style server: reply n is a list of stream chunks (objects), or {status, body} for an error
async function fakeChat(replies) {
  const bodies = [], headers = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }).on('end', async () => {
    bodies.push(JSON.parse(b));
    headers.push({ auth: req.headers.authorization, url: req.url });
    const r = replies[bodies.length - 1] || [{ choices: [{ delta: { content: 'end' } }] }];
    if (r.status) { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': OPENROUTER PROCESSING\n\n');
    for (const c of r) { const e = `data: ${JSON.stringify(c)}\n\n`; res.write(e.slice(0, 15)); await new Promise((x) => setTimeout(x, 2)); res.write(e.slice(15)); } // events split mid-way
    res.end('data: [DONE]\n\n');
  }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}/api/v1`;
  return { bodies, headers, baseUrl, provider: ai.openrouterProvider({ apiKey: 'k', model: 'vendor/model', baseUrl, fallbacks: ['vendor/backup'] }), close: () => srv.close() };
}

await ok('OpenRouter loop: streamed tool calls, reasoning replay, tool images, usage and cost', async () => {
  const s4 = lib.openSession('t4', tmp);
  const d = (delta) => ({ choices: [{ delta }] });
  const fake = await fakeChat([
    [d({ content: 'Look' }), d({ content: 'ing. ', reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'thi' }] }), d({ reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'nk', signature: 'sg' }] }),
      d({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'edit_sheet', arguments: '{"sheet":"1","ops":"[{\\"op\\":' } }] }),
      d({ tool_calls: [{ index: 0, function: { arguments: '\\"add\\",\\"sym\\":\\"resistor\\",\\"x\\":100,\\"y\\":100}]"}' } }] }),
      d({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'snapshot', arguments: '{"sheet":"1","width":400}' } }] }),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 } }],
    [d({ content: 'Done.' }), { choices: [], usage: { prompt_tokens: 150, completion_tokens: 5, cost: 0.002 } }],
  ]);
  const text = [];
  s4.chat.push({ role: 'user', text: 'draw a resistor', ctx: '[voltbridge] test\n\n', images: [] });
  try {
    const usage = await ai.runAgent({ provider: fake.provider, system: 'sys', messages: s4.chat, tools: ai.apiTools(lib.toolDefs(s4, toolCtx)), imageDir: tmp, onText: (t) => text.push(t) });
    assert.equal(text.join(''), 'Looking. Done.');
    assert.ok(s4.docs[1].parts.some((p) => p.sym === 'resistor'), 'arguments streamed in pieces were joined and ran');
    assert.equal(usage.prompt, 250); assert.equal(usage.output, 25); assert.ok(Math.abs(usage.cost - 0.003) < 1e-9);
    assert.deepEqual(fake.headers[0], { auth: 'Bearer k', url: '/api/v1/chat/completions' });
    const b0 = fake.bodies[0];
    assert.equal(b0.model, 'vendor/model'); assert.deepEqual(b0.models, ['vendor/model', 'vendor/backup']);
    assert.deepEqual(b0.provider, { require_parameters: true, data_collection: 'deny' });
    assert.equal(b0.messages[0].role, 'system');
    assert.equal(b0.messages[1].content, '[voltbridge] test\n\ndraw a resistor');
    assert.ok(b0.tools.some((t) => t.type === 'function' && t.function.name === 'edit_sheet' && t.function.parameters.type === 'object'));
    const m = fake.bodies[1].messages; // system, user, assistant(2 calls), tool, tool, user(images)
    assert.deepEqual(m.slice(1).map((x) => x.role), ['user', 'assistant', 'tool', 'tool', 'user']);
    assert.deepEqual(m[2].tool_calls.map((c) => [c.id, c.function.name]), [['call_a', 'edit_sheet'], ['call_b', 'snapshot']]);
    assert.equal(m[2].reasoning_details[0].text, 'think'); assert.equal(m[2].reasoning_details[0].signature, 'sg');
    assert.deepEqual(m.slice(3, 5).map((x) => x.tool_call_id), ['call_a', 'call_b']);
    assert.ok(m[5].content.some((c) => c.type === 'image_url' && c.image_url.url.startsWith('data:image/png;base64,')), 'snapshot goes to the model as an image');
  } finally { fake.close(); }
});

await ok('OpenRouter: image fallback, key, credits and missing model errors', async () => {
  const s5 = lib.openSession('t5', tmp);
  const fake = await fakeChat([
    [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'snapshot', arguments: '{"sheet":"1","width":400}' } }] } }] }],
    { status: 400, body: { error: { message: 'no image input' } } },
  ]);
  try {
    const messages = [{ role: 'user', text: 'look' }];
    await ai.runAgent({ provider: fake.provider, system: 's', messages, tools: ai.apiTools(lib.toolDefs(s5, toolCtx)), imageDir: tmp });
    const json = (i) => JSON.stringify(fake.bodies[i].messages);
    assert.ok(json(1).includes('image_url') && !json(2).includes('image_url'), 'after a 400 it retries without images');
  } finally { fake.close(); }
  for (const [status, re] of [[401, /OPENROUTER_API_KEY/], [402, /out of credits/]]) {
    const f = await fakeChat([{ status, body: { error: { message: 'x' } } }]);
    try { await assert.rejects(ai.runAgent({ provider: f.provider, system: 's', messages: [{ role: 'user', text: 'hi' }], tools: [], imageDir: tmp }), re); } finally { f.close(); }
  }
  assert.throws(() => ai.openrouterProvider({ apiKey: 'k' }), /OPENROUTER_MODEL/);
});


// ---------- sign-in and caps (auth.js) against a fake Supabase ----------
const { createAuth, costOf } = await import('./auth.js');

async function fakeSupabase(state) {
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }).on('end', () => {
    const u = new URL(req.url, 'http://x');
    const out = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    state.calls.push(`${req.method} ${u.pathname} ${req.headers.apikey}`);
    if (u.pathname.startsWith('/rest/')) (state.rest ||= []).push(req.headers.authorization);
    if (state.down) return out(500, { message: 'down' });
    if (u.pathname === '/auth/v1/.well-known/jwks.json') return out(200, { keys: state.jwks || [] });
    if (u.pathname === '/auth/v1/user') {
      const t = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      return t === 'good' ? out(200, { id: 'u1', email: 'Ann@Example.com', email_confirmed_at: '2026-11-01' })
        : t === 'unverified' ? out(200, { id: 'u2', email: 'bob@example.com' }) : out(401, { msg: 'bad jwt' });
    }
    if (u.pathname === '/rest/v1/allowed_emails') { const e = decodeURIComponent(u.searchParams.get('email').slice(3)); return out(200, state.allowed[e] != null ? [{ monthly_cap_usd: state.allowed[e] }] : []); }
    if (u.pathname === '/rest/v1/rpc/month_spend') return out(200, state.spent);
    if (u.pathname === '/rest/v1/rpc/month_spend_all') return out(200, state.all);
    if (u.pathname === '/rest/v1/usage') { state.usage.push(JSON.parse(b)); return out(201); }
    out(404, {});
  }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

await ok('sign-in: token check, signed cookie (forged and expired ones refused)', async () => {
  const state = { calls: [], allowed: {}, spent: 0, all: 0, usage: [] };
  const sb = await fakeSupabase(state);
  let t = 1000000;
  const a = createAuth({ url: sb.url, serviceKey: 'svc', now: () => t });
  try {
    assert.deepEqual(await a.login('good'), { id: 'u1', email: 'ann@example.com' }, 'email is lower-cased');
    await assert.rejects(a.login('nope'), /not accepted/);
    await assert.rejects(a.login('unverified'), /verified email/);
    const v = a.sign({ id: 'u1', email: 'ann@example.com' });
    assert.deepEqual(a.read(`x=1; vb=${v}`), { id: 'u1', email: 'ann@example.com' });
    const [body, tag] = v.split('.');
    const forged = Buffer.from(JSON.stringify({ id: 'u9', email: 'evil@x.com', exp: t + 1e9 })).toString('base64url');
    assert.equal(a.read(`vb=${forged}.${tag}`), null, 'a changed body does not verify');
    assert.equal(a.read(`vb=${body}.${tag.slice(1)}x`), null);
    assert.equal(createAuth({ url: sb.url, serviceKey: 'other', now: () => t }).read(`vb=${v}`), null, 'another server key does not verify it');
    assert.equal(a.read(''), null);
    t += 8 * 86400000;
    assert.equal(a.read(`vb=${v}`), null, 'expires after 7 days');
    assert.ok(state.calls.every((c) => c.endsWith(' svc')), 'every call carries the service key header');
  } finally { sb.close(); }
});

await ok('sign-in: ES256 access tokens are verified with the project public key (no API key involved)', async () => {
  const crypto = await import('node:crypto');
  const mk = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pair = mk(), other = mk();
  const state = { calls: [], allowed: {}, spent: 0, all: 0, usage: [], jwks: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', use: 'sig', key_ops: ['verify'], ext: true }] };
  const sb = await fakeSupabase(state);
  const a = createAuth({ url: sb.url, serviceKey: 'sb_secret_x' });
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (claims = {}, { key = pair.privateKey, kid = 'k1' } = {}) => {
    const data = b64u({ alg: 'ES256', typ: 'JWT', kid }) + '.' + b64u({ sub: 'u7', email: 'Ann@Example.com', aud: 'authenticated', iss: sb.url + '/auth/v1', exp: Math.floor(Date.now() / 1000) + 3600, user_metadata: { email_verified: true }, app_metadata: { provider: 'google' }, ...claims });
    return data + '.' + crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  };
  const quiet = console.error; console.error = () => {};
  try {
    assert.deepEqual(await a.login(jwt()), { id: 'u7', email: 'ann@example.com' });
    assert.ok(!state.calls.some((c) => c.includes('/auth/v1/user')), 'no call to Supabase with our key');
    const good = jwt(); const [h, p, s] = good.split('.');
    const forged = b64u({ sub: 'u9', email: 'evil@x.com', aud: 'authenticated', iss: sb.url + '/auth/v1', exp: 9999999999, user_metadata: { email_verified: true } });
    await assert.rejects(a.login([h, forged, s].join('.')), /not accepted/, 'changed payload');
    await assert.rejects(a.login(jwt({}, { key: other.privateKey })), /not accepted/, 'signed by another key');
    await assert.rejects(a.login(jwt({ exp: Math.floor(Date.now() / 1000) - 10 })), /not accepted/, 'expired');
    await assert.rejects(a.login(jwt({ iss: 'https://evil.example/auth/v1' })), /not accepted/, 'another project');
    await assert.rejects(a.login(jwt({ aud: 'anon' })), /not accepted/, 'wrong audience');
    await assert.rejects(a.login(jwt({}, { kid: 'nope' })), /not accepted/, 'unknown key id');
    await assert.rejects(a.login(jwt({ user_metadata: {}, app_metadata: { provider: 'email' } })), /verified email/);
  } finally { console.error = quiet; sb.close(); }
});

await ok('new-style secret keys (sb_secret_...) go in apikey only, legacy JWT keys also in Authorization', async () => {
  const state = { calls: [], allowed: {}, spent: 0, all: 0, usage: [] };
  const sb = await fakeSupabase(state);
  try {
    await createAuth({ url: sb.url, serviceKey: 'sb_secret_abc' }).limits({ id: 'u1', email: 'ann@example.com' });
    assert.ok(state.rest.length >= 3 && state.rest.every((a) => a === undefined), 'no Authorization header for an sb_ key');
    state.rest = [];
    await createAuth({ url: sb.url, serviceKey: 'eyJlegacy.jwt.key' }).limits({ id: 'u1', email: 'ann@example.com' });
    assert.ok(state.rest.every((a) => a === 'Bearer eyJlegacy.jwt.key'));
    assert.ok(state.calls.some((c) => c.endsWith(' sb_secret_abc')), 'the key is sent as apikey');
  } finally { sb.close(); }
});

await ok('caps: per user, whole server, custom allowance, closed signup, Supabase down', async () => {
  const state = { calls: [], allowed: { 'vip@example.com': 5, 'blocked@example.com': 0 }, spent: 0.2, all: 3, usage: [] };
  const sb = await fakeSupabase(state);
  const a = createAuth({ url: sb.url, serviceKey: 'svc', userCap: 0.5, globalCap: 10 });
  const ann = { id: 'u1', email: 'ann@example.com' };
  try {
    assert.deepEqual(await a.limits(ann), { ok: true, cap: 0.5, spent: 0.2 });
    state.spent = 0.5;
    assert.match((await a.limits(ann)).reason, /allowance for this month \(\$0\.50\)/);
    assert.deepEqual(await a.limits({ id: 'u3', email: 'vip@example.com' }), { ok: true, cap: 5, spent: 0.5 }, 'a listed email gets its own cap');
    assert.equal((await a.limits({ id: 'u4', email: 'blocked@example.com' })).ok, false, 'cap 0 blocks');
    state.spent = 0; state.all = 10;
    assert.match((await a.limits(ann)).reason, /budget for this month/, 'the server-wide cap stops everyone');
    state.all = 0;
    assert.equal((await createAuth({ url: sb.url, serviceKey: 'svc', open: false }).limits(ann)).ok, false, 'closed signup needs a listed email');
    assert.equal((await createAuth({ url: sb.url, serviceKey: 'svc', open: false }).limits({ id: 'u3', email: 'vip@example.com' })).ok, true);
    await a.record(ann, { model: 'm', prompt: 100, output: 20, cost: 0.01 });
    assert.deepEqual(state.usage, [{ user_id: 'u1', email: 'ann@example.com', model: 'm', tokens_in: 100, tokens_out: 20, cost_usd: 0.01 }]);
    state.down = true;
    const r = await a.limits(ann);
    assert.ok(!r.ok && /Could not check/.test(r.reason), 'fails closed');
    await a.record(ann, { model: 'm' }); // a failed write is logged, not thrown
  } finally { sb.close(); }
  assert.equal(costOf({ prompt: 1000000, output: 1000000, cost: 0.3 }), 0.3);
  assert.equal(costOf({ prompt: 1000000, output: 1000000 }), 6, 'without a reported cost, a high estimate is used');
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${n} passed${process.exitCode ? ', some FAILED' : ''}`);
