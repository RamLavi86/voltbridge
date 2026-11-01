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

// ---------- the API loop (ai.js) against a scripted fake Gemini ----------
const ai = await import('./ai.js');
const http = await import('node:http');

await ok('tool schemas fit Gemini: no property-less objects, free-form args as JSON strings', () => {
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

await ok('agent loop: tools, replayed thought signatures, image fallback, split SSE events', async () => {
  const s2 = lib.openSession('t2', tmp);
  const bodies = [], headers = [];
  const sse = (parts) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } })}\n\n`;
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }).on('end', async () => {
      const body = JSON.parse(b); bodies.push(body); headers.push(req.headers['x-goog-api-key'] + ' ' + req.url);
      const n = bodies.length;
      const lastParts = body.contents.at(-1).parts;
      if (n === 4 && lastParts.some((p) => p.inlineData)) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'no images here' } })); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (n === 1) res.end(sse([{ text: 'Looking. ' }, { functionCall: { name: 'list_sheets', args: {} }, thoughtSignature: 'sig1' }]));
      else if (n === 2) res.end(sse([{ functionCall: { name: 'edit_sheet', args: { sheet: '1', ops: JSON.stringify([{ op: 'add', sym: 'resistor', x: 100, y: 100 }]) } } }]));
      else if (n === 3) res.end(sse([{ functionCall: { name: 'snapshot', args: { sheet: '1', width: 400 } } }]));
      else { const e = sse([{ text: 'Done.' }]); res.write(e.slice(0, 40)); await new Promise((r) => setTimeout(r, 20)); res.end(e.slice(40)); }
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    const text = [], seen = [];
    s2.chat.push({ role: 'user', text: 'draw a resistor', ctx: '[voltbridge] test\n\n', images: [] });
    const usage = await ai.runAgent({
      provider: ai.geminiProvider({ apiKey: 'k', baseUrl: `http://127.0.0.1:${fake.address().port}` }),
      system: 'sys', messages: s2.chat, tools: ai.apiTools(lib.toolDefs(s2, { sheetChanged() {}, sheetsChanged() {}, exported() {} })), imageDir: tmp,
      onText: (t) => text.push(t), onTool: (c) => seen.push(c.name),
    });
    assert.equal(text.join(''), 'Looking. Done.');
    assert.deepEqual(seen, ['list_sheets', 'edit_sheet', 'snapshot']);
    assert.ok(s2.docs[1].parts.some((p) => p.sym === 'resistor'), 'edit_sheet ran with its JSON-string ops');
    assert.deepEqual(s2.chat.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
    assert.deepEqual(usage, { prompt: 40, output: 20 }, 'four answered steps; the rejected request adds nothing');
    assert.equal(headers[0], 'k /v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse', 'key goes in a header, not the URL');
    assert.ok(bodies[0].tools[0].functionDeclarations.some((d) => d.name === 'edit_sheet'));
    assert.equal(bodies[0].contents[0].parts.at(-1).text, '[voltbridge] test\n\ndraw a resistor');
    assert.equal(bodies[1].contents[1].parts[1].thoughtSignature, 'sig1', 'model parts are replayed as received');
    assert.equal(bodies[1].contents[2].parts[0].functionResponse.name, 'list_sheets');
    assert.ok(bodies[3].contents.at(-1).parts.some((p) => p.inlineData), 'first try sends the snapshot');
    assert.ok(!bodies[4].contents.at(-1).parts.some((p) => p.inlineData), 'after a 400 it retries without images');
    lib.saveChat(s2);
    const saved = fs.readFileSync(path.join(s2.dir, 'chat.json'), 'utf8');
    assert.ok(!saved.includes('"shots"') && lib.openSession('t2', tmp).chat.length === 8, 'chat is saved without tool images and reloads');
  } finally { fake.close(); }
});

await ok('a rejected API key gives a clear error', async () => {
  const fake = http.createServer((req, res) => { req.resume().on('end', () => { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'API key not valid' } })); }); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(ai.runAgent({ provider: ai.geminiProvider({ apiKey: 'bad', baseUrl: `http://127.0.0.1:${fake.address().port}` }), system: 's', messages: [{ role: 'user', text: 'hi' }], tools: [], imageDir: tmp }), /GEMINI_API_KEY/);
  } finally { fake.close(); }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${n} passed${process.exitCode ? ', some FAILED' : ''}`);
