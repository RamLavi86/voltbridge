// The schematic model, shared by the server (Claude's tools, PNG snapshots, exports) and the browser editor.
// A sheet is { id, name, size, title, parts, wires, labels, rev }. Coordinates are px on a 10px grid.
// part:  { id, ref, sym, x, y, rot: 0|90|180|270, mirror, props }   (several parts may share a ref: a coil and its contacts)
// wire:  { id, pts: [[x,y], ...], kind?: 'bus' }                    (orthogonal polyline)
// label: { id, kind: 'net'|'text', text, x, y }                     (a net label names the net at its point; same name = same net, across sheets)

export const GRID = 10;
export const snap = (v) => Math.round(v / GRID) * GRID;

// ---------- symbols ----------
// Local coordinates, origin at the part's anchor; two-terminal parts stand vertically with pin 1 on top (current flows down,
// as in IEC control and power circuits). Rotate 90 for a horizontal part. Shapes: { d } path, { c: [cx, cy, r] } circle,
// { t: [x, y, text, size?] } text (kept upright when the part rotates). fill: true fills with ink, dash: true dashes.
const two = (a = '1', b = '2', h = 30) => [{ n: a, x: 0, y: -h }, { n: b, x: 0, y: h }];
const leads = (h = 30, i = 10) => `M0 ${-h}V${-i}M0 ${i}V${h}`;
const NO = 'M0 10L-9 -8', NC = 'M0 10L9 -12M0 -10H9';
const S = {};
const def = (key, o) => { S[key] = { key, ...o }; };

// General
def('resistor', { name: 'Resistor', cat: 'Passive', prefix: 'R', pins: two(), box: [-6, -30, 6, 30], shapes: [{ d: leads(30, 15) + 'M-5 -15h10v30h-10z' }], value: '1k' });
def('capacitor', { name: 'Capacitor', cat: 'Passive', prefix: 'C', pins: two(), box: [-12, -30, 12, 30], shapes: [{ d: leads(30, 4) + 'M-12 -4H12M-12 4H12' }], value: '100n' });
def('cap_polar', { name: 'Capacitor, polarised', cat: 'Passive', prefix: 'C', pins: two('+', '-'), box: [-12, -30, 12, 30], shapes: [{ d: leads(30, 4) + 'M-12 -4H12M-12 7Q0 2 12 7M0 5V4' }, { t: [-9, -12, '+', 9] }], value: '100u' });
def('inductor', { name: 'Inductor', cat: 'Passive', prefix: 'L', pins: two(), box: [-2, -30, 6, 30], shapes: [{ d: 'M0 -30V-16a4 4 0 0 1 0 8a4 4 0 0 1 0 8a4 4 0 0 1 0 8a4 4 0 0 1 0 8V30' }], value: '10u' });
def('diode', { name: 'Diode', cat: 'Semiconductor', prefix: 'V', pins: two('A', 'K'), box: [-8, -30, 8, 30], shapes: [{ d: leads(30, 7) + 'M-8 7H8' }, { d: 'M-8 -7H8L0 7z', fill: true }] });
def('zener', { name: 'Zener diode', cat: 'Semiconductor', prefix: 'V', pins: two('A', 'K'), box: [-10, -30, 10, 30], shapes: [{ d: leads(30, 7) + 'M-11 10L-8 7H8L11 4' }, { d: 'M-8 -7H8L0 7z', fill: true }] });
def('led', { name: 'LED', cat: 'Semiconductor', prefix: 'V', pins: two('A', 'K'), box: [-8, -30, 18, 30], shapes: [{ d: leads(30, 7) + 'M-8 7H8M10 -4l6 -6M12.5 -10H16V-6.5M10 4l6 -6M12.5 -2H16V1.5' }, { d: 'M-8 -7H8L0 7z', fill: true }] });
def('npn', { name: 'NPN transistor', cat: 'Semiconductor', prefix: 'V', pins: [{ n: 'B', x: -30, y: 0 }, { n: 'C', x: 10, y: -30 }, { n: 'E', x: 10, y: 30 }], box: [-30, -30, 18, 30],
  shapes: [{ c: [3, 0, 15] }, { d: 'M-30 0H-6M-6 -10V10M-6 -4L10 -14V-30M-6 4L10 14V30' }, { d: 'M10 14L2 13L6 8z', fill: true }] });
def('pnp', { name: 'PNP transistor', cat: 'Semiconductor', prefix: 'V', pins: [{ n: 'B', x: -30, y: 0 }, { n: 'E', x: 10, y: -30 }, { n: 'C', x: 10, y: 30 }], box: [-30, -30, 18, 30],
  shapes: [{ c: [3, 0, 15] }, { d: 'M-30 0H-6M-6 -10V10M-6 -4L10 -14V-30M-6 4L10 14V30' }, { d: 'M-6 -4L1 -2L-2 -9z', fill: true }] });

// Power symbols: name the net they touch (props.net)
def('gnd', { name: 'Ground', cat: 'Power symbols', power: 'GND', pins: [{ n: '1', x: 0, y: -10 }], box: [-10, -10, 10, 8], shapes: [{ d: 'M0 -10V0M-10 0H10M-6 4H6M-2 8H2' }] });
def('pe', { name: 'Protective earth (PE)', cat: 'Power symbols', power: 'PE', pins: [{ n: '1', x: 0, y: -10 }], box: [-11, -10, 11, 13], shapes: [{ d: 'M0 -10V0M-7 0H7M-4.5 3.5H4.5M-2 7H2' }, { c: [0, 3, 10] }] });
def('rail', { name: 'Supply rail (e.g. +24V)', cat: 'Power symbols', power: '+24V', pins: [{ n: '1', x: 0, y: 10 }], box: [-10, -4, 10, 10], shapes: [{ d: 'M0 10V0M-10 0H10' }], netText: [0, -6] });

// Sources and storage
def('battery', { name: 'Battery / DC source', cat: 'Sources', prefix: 'G', pins: two('+', '-'), box: [-14, -30, 14, 30], shapes: [{ d: leads(30, 6) + 'M-14 -6H14M-7 0H7M-14 6H14M-7 12H7M0 12V30' }, { t: [-11, -12, '+', 9] }], value: '48V' });
def('ac_source', { name: 'AC source', cat: 'Sources', prefix: 'G', pins: two('L', 'N'), box: [-14, -30, 14, 30], shapes: [{ d: leads(30, 14) }, { c: [0, 0, 14] }, { d: 'M-8 0q4 -8 8 0t8 0' }], value: '230V 50Hz' });
def('pv_module', { name: 'PV module', cat: 'Sources', prefix: 'G', pins: two('+', '-', 40), box: [-20, -40, 20, 40],
  shapes: [{ d: 'M0 -40V-16M0 16V40M-16 -16h32v32h-32z' }, { d: 'M-7 -3H7L0 7z', fill: true }, { d: 'M-7 7H7M-30 -30l10 10M-23.5 -20H-20V-23.5M-24 -36l10 10M-17.5 -26H-14V-29.5' }, { t: [-11, -21, '+', 9] }], value: '400W' });
def('grid', { name: 'Utility grid', cat: 'Sources', prefix: 'G', pins: [{ n: '1', x: 0, y: 30 }], box: [-16, -10, 16, 30], shapes: [{ d: 'M-16 -10h32v24h-32zM-16 -2H16M-16 6H16M-8 -10V14M0 -10V14M8 -10V14M0 14V30' }] });
def('generator', { name: 'Generator', cat: 'Sources', prefix: 'G', pins: [{ n: '1', x: 0, y: 30 }], box: [-16, -16, 16, 30], shapes: [{ c: [0, 0, 16] }, { t: [0, 4, 'G', 13] }, { d: 'M0 16V30' }] });

def('pv_array', { name: 'PV array (single-line)', cat: 'Sources', prefix: 'G', pins: [{ n: '1', x: 0, y: 40 }], box: [-30, -36, 20, 40],
  shapes: [{ d: 'M0 16V40M-16 -16h32v32h-32z' }, { d: 'M-7 -3H7L0 7z', fill: true }, { d: 'M-7 7H7M-30 -30l10 10M-23.5 -20H-20V-23.5M-24 -36l10 10M-17.5 -26H-14V-29.5' }], value: '10kWp' });
def('battery_storage', { name: 'Battery storage (single-line)', cat: 'Sources', prefix: 'G', pins: [{ n: '1', x: 0, y: -30 }], box: [-18, -30, 18, 14],
  shapes: [{ d: 'M0 -30V-14M-18 -14h36v28h-36zM-9 -7V7M-4 -3V3M4 -7V7M9 -3V3' }], value: '10kWh' });

// Protection and switching (IEC 60617)
def('fuse', { name: 'Fuse', cat: 'Protection', prefix: 'F', pins: two(), box: [-6, -30, 6, 30], shapes: [{ d: 'M0 -30V30M-5 -14h10v28h-10z' }], value: '10A' , poleMark: true });
def('breaker', { name: 'Circuit breaker, 1-pole', cat: 'Protection', prefix: 'Q', pins: two(), box: [-10, -30, 6, 30], shapes: [{ d: leads(30) + NO + 'M-4 -14L4 -6M4 -14L-4 -6' }], value: 'C16' , poleMark: true });
def('breaker_3p', { name: 'Circuit breaker, 3-pole', cat: 'Protection', prefix: 'Q', pins: [{ n: '1', x: -20, y: -30 }, { n: '3', x: 0, y: -30 }, { n: '5', x: 20, y: -30 }, { n: '2', x: -20, y: 30 }, { n: '4', x: 0, y: 30 }, { n: '6', x: 20, y: 30 }], box: [-30, -30, 26, 30],
  shapes: [-20, 0, 20].map((x) => ({ d: `M${x} -30V-10M${x} 10V30M${x} 10L${x - 9} -8M${x - 4} -14L${x + 4} -6M${x + 4} -14L${x - 4} -6` })).concat([{ d: 'M-24 1H16', dash: true }]), value: 'C32' });
// Multi-pole devices: poles at x = -30, -10, 10, 30 (or -10, 10), pins 1/3/5/N on top and 2/4/6/N' below.
const pole = (x, cross) => `M${x} -30V-10M${x} 10V30M${x} 10L${x - 9} -8` + (cross ? `M${x - 4} -14L${x + 4} -6M${x + 4} -14L${x - 4} -6` : '');
const polePins = (xs, top, bot) => [...xs.map((x, i) => ({ n: top[i], x, y: -30 })), ...xs.map((x, i) => ({ n: bot[i], x, y: 30 }))];
const X4 = [-30, -10, 10, 30], X2 = [-10, 10];
const P4 = polePins(X4, ['1', '3', '5', 'N'], ['2', '4', '6', "N'"]), P2N = polePins(X2, ['1', 'N'], ['2', "N'"]);
// residual-current release: a toroid around the poles at y=20, tied to the mechanism, and a test button T at tx
const toroid = (r, tx) => [{ d: `M${-r} 20a${r} 5 0 1 0 ${2 * r} 0a${r} 5 0 1 0 ${-2 * r} 0` }, { d: `M${r} 20H${tx}V1M${-r + 4} 1H${tx}`, dash: true }, { d: `M${tx} 1V-14M${tx - 4} -14H${tx + 4}` }, { t: [tx + 7, -17, 'T', 8] }];
// single-line form of the RCD: one pin in, one out (used when props.poles is set)
const rcdSld = { pins: two(), box: [-10, -30, 26, 30], shapes: [{ d: leads(30) + NO + 'M-8 20a8 3 0 1 0 16 0a8 3 0 1 0 -16 0' }, { d: 'M8 20H18V1M-4.5 1H18', dash: true }, { d: 'M18 1V-14M14 -14H22' }, { t: [25, -17, 'T', 8] }] };
def('rcd', { name: 'RCD, 2-pole (set poles for single-line)', cat: 'Protection', prefix: 'Q', pins: polePins(X2, ['1', '3'], ['2', '4']), box: [-20, -30, 36, 30],
  shapes: [{ d: X2.map((x) => pole(x)).join('') }, ...toroid(14, 26)], value: '40A 30mA', sld: rcdSld, poleMark: true });
def('rcd_4p', { name: 'RCD, 4-pole', cat: 'Protection', prefix: 'Q', pins: P4, box: [-40, -30, 56, 30], shapes: [{ d: X4.map((x) => pole(x)).join('') }, ...toroid(36, 46)], value: '40A 30mA' });
def('rcbo', { name: 'RCBO, 1P+N', cat: 'Protection', prefix: 'Q', pins: P2N, box: [-20, -30, 36, 30], shapes: [{ d: X2.map((x) => pole(x, true)).join('') }, ...toroid(14, 26)], value: 'C16 30mA' });
def('breaker_4p', { name: 'Circuit breaker, 3P+N', cat: 'Protection', prefix: 'Q', pins: P4, box: [-40, -30, 36, 30], shapes: [{ d: X4.map((x) => pole(x, true)).join('') }, { d: 'M-34 1H26', dash: true }], value: 'C40' });
def('switch_disconnector_4p', { name: 'Switch-disconnector, 4-pole (main switch)', cat: 'Protection', prefix: 'Q', pins: P4, box: [-40, -30, 36, 30],
  shapes: [{ d: X4.map((x) => pole(x) + `M${x - 5} -10H${x + 5}`).join('') }, ...X4.map((x) => ({ c: [x, -13, 2.5] })), { d: 'M-34 1H26', dash: true }], value: '63A' });
def('disconnector', { name: 'Disconnector / isolator', cat: 'Protection', prefix: 'Q', pins: two(), box: [-10, -30, 6, 30], shapes: [{ d: leads(30) + NO + 'M-5 -10H5' }] , poleMark: true });
def('spd', { name: 'Surge protective device', cat: 'Protection', prefix: 'F', pins: two('1', 'PE'), box: [-7, -30, 7, 30], shapes: [{ d: leads(30, 14) + 'M-6 -14h12v28h-12zM0 -14V-4L-3 2H3L0 8V14' }, { d: 'M0 14L-2.5 8H2.5z', fill: true }] , poleMark: true });

def('switch_no', { name: 'Switch, NO', cat: 'Switching', prefix: 'S', pins: two('13', '14'), box: [-10, -30, 4, 30], shapes: [{ d: leads(30) + NO }] });
def('switch_nc', { name: 'Switch, NC', cat: 'Switching', prefix: 'S', pins: two('11', '12'), box: [-4, -30, 10, 30], shapes: [{ d: leads(30) + NC }] });
def('push_no', { name: 'Pushbutton, NO', cat: 'Switching', prefix: 'S', pins: two('13', '14'), box: [-18, -30, 4, 30], shapes: [{ d: leads(30) + NO }, { d: 'M-4.5 -1H-15', dash: true }, { d: 'M-15 -5V3M-15 -5h-3M-15 3h-3' }] });
def('push_nc', { name: 'Pushbutton, NC', cat: 'Switching', prefix: 'S', pins: two('11', '12'), box: [-18, -30, 10, 30], shapes: [{ d: leads(30) + NC }, { d: 'M4.5 -1H-15', dash: true }, { d: 'M-15 -5V3M-15 -5h-3M-15 3h-3' }] });
def('estop', { name: 'Emergency stop, NC', cat: 'Switching', prefix: 'S', pins: two('11', '12'), box: [-22, -30, 10, 30], shapes: [{ d: leads(30) + NC }, { d: 'M4.5 -1H-15', dash: true }, { d: 'M-15 -7V5M-15 -7a6 6 0 0 0 0 12' }] });
def('coil', { name: 'Relay / contactor coil', cat: 'Switching', prefix: 'K', pins: two('A1', 'A2'), box: [-12, -30, 12, 30], shapes: [{ d: leads(30, 8) + 'M-12 -8h24v16h-24z' }], value: '24VDC' });
def('contact_no', { name: 'Relay contact, NO', cat: 'Switching', prefix: 'K', contact: true, pins: two('13', '14'), box: [-10, -30, 4, 30], shapes: [{ d: leads(30) + NO }] });
def('contact_nc', { name: 'Relay contact, NC', cat: 'Switching', prefix: 'K', contact: true, pins: two('21', '22'), box: [-4, -30, 10, 30], shapes: [{ d: leads(30) + NC }] });
def('contactor_3p', { name: 'Contactor main contacts, 3-pole', cat: 'Switching', prefix: 'K', contact: true, pins: [{ n: '1', x: -20, y: -30 }, { n: '3', x: 0, y: -30 }, { n: '5', x: 20, y: -30 }, { n: '2', x: -20, y: 30 }, { n: '4', x: 0, y: 30 }, { n: '6', x: 20, y: 30 }], box: [-30, -30, 26, 30],
  shapes: [-20, 0, 20].map((x) => ({ d: `M${x} -30V-10M${x} 10V30M${x} 10L${x - 9} -8M${x} -10a4 4 0 0 1 -4 -4` })).concat([{ d: 'M-24 1H16', dash: true }]) });

// Loads, machines, measurement
def('motor_3p', { name: 'Motor, 3-phase', cat: 'Loads', prefix: 'M', pins: [{ n: 'U', x: -10, y: -30 }, { n: 'V', x: 0, y: -30 }, { n: 'W', x: 10, y: -30 }, { n: 'PE', x: 20, y: -30 }], box: [-18, -30, 24, 24],
  shapes: [{ c: [0, 8, 16] }, { d: 'M-10 -30V-4.5M0 -30V-8M10 -30V-4.5M20 -30V-10L13 -2', dash: false }, { t: [0, 8, 'M', 12] }, { t: [0, 19, '3~', 8] }], value: '4kW' });
def('motor_dc', { name: 'Motor, DC', cat: 'Loads', prefix: 'M', pins: two('+', '-'), box: [-16, -30, 16, 30], shapes: [{ d: leads(30, 16) }, { c: [0, 0, 16] }, { t: [0, 0, 'M', 12] }, { t: [0, 10, '=', 8] }] });
def('lamp', { name: 'Lamp / indicator', cat: 'Loads', prefix: 'H', pins: two('X1', 'X2'), box: [-10, -30, 10, 30], shapes: [{ d: leads(30, 10) + 'M-7 -7L7 7M7 -7L-7 7' }, { c: [0, 0, 10] }] });
def('heater', { name: 'Heater', cat: 'Loads', prefix: 'E', pins: two(), box: [-8, -30, 8, 30], shapes: [{ d: leads(30, 15) + 'M-7 -15h14v30h-14zM-7 -5H7M-7 5H7' }] });
def('load', { name: 'Load (generic)', cat: 'Loads', prefix: 'E', pins: [{ n: '1', x: 0, y: -30 }], box: [-20, -30, 20, 14], shapes: [{ d: 'M0 -30V-14M-20 -14h40v28h-40z' }, { t: [0, 0, 'LOAD', 8] }] });
// Installation loads (IEC 60617 part 11 style), one pin on top: a single-line circuit ends here
const appliance = (inner) => [{ d: 'M0 -30V-14M-16 -14h32v28h-32z' }, ...inner];
def('socket', { name: 'Socket outlet (set ways for n-way)', cat: 'Loads', prefix: 'X', pins: [{ n: '1', x: 0, y: -30 }], box: [-11, -30, 11, 5], shapes: [{ d: 'M0 -30V-6M-11 -6H11M-9 -6a9 9 0 0 0 18 0' }, { t: [0, -1, '{ways}', 7] }], props: { ways: '' } });
def('light', { name: 'Lighting point', cat: 'Loads', prefix: 'E', pins: [{ n: '1', x: 0, y: -30 }], box: [-10, -30, 10, 10], shapes: [{ d: 'M0 -30V-10M-7 -7L7 7M7 -7L-7 7' }, { c: [0, 0, 10] }] });
def('water_heater', { name: 'Water heater / boiler', cat: 'Loads', prefix: 'E', pins: [{ n: '1', x: 0, y: -30 }], box: [-16, -30, 16, 14], shapes: appliance([{ d: 'M-8 -6h16v12h-16zM-8 0H8' }, { d: 'M-10 9q2.5 -2 5 0t5 0t5 0t5 0' }]) });
def('cooker', { name: 'Cooker / hob', cat: 'Loads', prefix: 'E', pins: [{ n: '1', x: 0, y: -30 }], box: [-16, -30, 16, 14], shapes: appliance([{ c: [-7, -6, 3.5] }, { c: [7, -6, 3.5] }, { c: [-7, 6, 3.5] }, { c: [7, 6, 3.5] }]) });
def('ac_unit', { name: 'Air conditioner', cat: 'Loads', prefix: 'E', pins: [{ n: '1', x: 0, y: -30 }], box: [-16, -30, 16, 14], shapes: appliance([{ d: 'M0 -9V9M-8 -4.5L8 4.5M-8 4.5L8 -4.5M-3 -9L0 -6L3 -9M-3 9L0 6L3 9' }]) });
def('ev_charger', { name: 'EV charger', cat: 'Loads', prefix: 'E', pins: [{ n: '1', x: 0, y: -30 }], box: [-16, -30, 16, 14], shapes: appliance([{ t: [0, -4, 'EV', 9] }, { d: 'M-6 5h12M-3 5v4M3 5v4' }]) });
def('transformer', { name: 'Transformer', cat: 'Loads', prefix: 'T', pins: two('1', '2', 30), box: [-12, -30, 12, 30], shapes: [{ d: 'M0 -30V-20M0 20V30' }, { c: [0, -7, 13] }, { c: [0, 7, 13] }], value: '400/230V' });
def('ct', { name: 'Current transformer', cat: 'Measurement', prefix: 'T', pins: two('P1', 'P2'), box: [-9, -30, 9, 30], shapes: [{ d: 'M0 -30V30' }, { c: [0, 0, 8] }] });
def('meter', { name: 'Meter (V, A, W, Hz)', cat: 'Measurement', prefix: 'P', pins: two(), box: [-12, -30, 12, 30], shapes: [{ d: leads(30, 12) }, { c: [0, 0, 12] }, { t: [0, 0, '{unit}', 11] }], props: { unit: 'V' } });
def('energy_meter', { name: 'Energy meter (kWh)', cat: 'Measurement', prefix: 'P', pins: two(), box: [-14, -30, 14, 30], shapes: [{ d: leads(30, 12) + 'M-14 -12h28v24h-28zM-14 -4H14' }, { t: [0, 5, 'kWh', 8] }] });

// Power conversion and building blocks
def('inverter', { name: 'Inverter (DC/AC)', cat: 'Conversion', prefix: 'U', pins: [{ n: 'DC', x: 0, y: -40 }, { n: 'AC', x: 0, y: 40 }], box: [-20, -40, 20, 40], shapes: [{ d: 'M0 -40V-20M0 20V40M-20 -20h40v40h-40zM-20 20L20 -20' }, { t: [-9, -9, '=', 11] }, { t: [9, 9, '~', 13] }], value: '' });
def('hybrid_inverter', { name: 'Hybrid inverter (PV + battery)', cat: 'Conversion', prefix: 'U', pins: [{ n: 'PV', x: -20, y: -40 }, { n: 'BAT', x: 20, y: -40 }, { n: 'AC', x: 0, y: 40 }], box: [-30, -40, 30, 40],
  shapes: [{ d: 'M-20 -40V-20M20 -40V-20M0 20V40M-30 -20h60v40h-60zM-30 20L30 -20' }, { t: [-16, -8, '=', 11] }, { t: [16, 9, '~', 13] }, { t: [-20, -27, 'PV', 6], anchor: 'end' }, { t: [20, -27, 'BAT', 6], anchor: 'start' }], value: '10kW' });
def('converter_dc', { name: 'DC/DC converter', cat: 'Conversion', prefix: 'U', pins: [{ n: 'IN', x: 0, y: -40 }, { n: 'OUT', x: 0, y: 40 }], box: [-20, -40, 20, 40], shapes: [{ d: 'M0 -40V-20M0 20V40M-20 -20h40v40h-40zM-20 20L20 -20' }, { t: [-9, -9, '=', 11] }, { t: [9, 9, '=', 11] }] });
def('rectifier', { name: 'Rectifier (AC/DC)', cat: 'Conversion', prefix: 'U', pins: [{ n: 'AC', x: 0, y: -40 }, { n: 'DC', x: 0, y: 40 }], box: [-20, -40, 20, 40], shapes: [{ d: 'M0 -40V-20M0 20V40M-20 -20h40v40h-40zM-20 20L20 -20' }, { t: [-9, -9, '~', 13] }, { t: [9, 9, '=', 11] }] });
def('terminal', { name: 'Terminal', cat: 'Wiring', prefix: 'X', pins: two('1', '2', 10), box: [-4, -10, 4, 10], shapes: [{ d: 'M0 -10V-3.5M0 3.5V10' }, { c: [0, 0, 3.5] }] });
def('connector', { name: 'Plug / socket', cat: 'Wiring', prefix: 'X', pins: two('1', '2', 20), box: [-7, -20, 7, 20], shapes: [{ d: 'M0 -20V-4M0 4V20M-6 -4H6M-6 4a6 6 0 0 0 12 0' }] });
// N / PE bars: a bar with props.ways terminals hanging down, 20px apart (pins 1..n)
def('n_bar', { name: 'Neutral bar', cat: 'Wiring', prefix: 'X', dynamic: true, bar: 'N', props: { ways: '6' } });
def('pe_bar', { name: 'Earth (PE) bar', cat: 'Wiring', prefix: 'X', dynamic: true, bar: 'PE', props: { ways: '6' } });
// A box with named pins on each side, 20px apart: props.left/right/top/bottom are pin name lists, props.label the text.
def('block', { name: 'Block (PLC, IC, device)', cat: 'Wiring', prefix: 'A', dynamic: true, props: { label: 'DEVICE', left: '1,2', right: '3,4', top: '', bottom: '' } });

export const SYMBOLS = S;
export const CATEGORIES = [...new Set(Object.values(S).map((s) => s.cat))];

const list = (v) => (Array.isArray(v) ? v.map(String) : String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean));
// The resolved symbol for a part: blocks are built from their props.
// "3" -> 3, "3P+N" -> 4, "1P+N" -> 2
export const poleCount = (v) => { const m = /(\d+)/.exec(String(v ?? '')); return m ? +m[1] + (/\+\s*N/i.test(v) ? 1 : 0) : 0; };
// IEC 60617 pole marking on a single line: n short oblique strokes, or one stroke and the number when n > 3
function poleTicks(n) {
  if (n <= 1) return [];
  if (n > 3) return [{ d: 'M-4 -20L4 -24' }, { t: [-6, -22, String(n), 8], anchor: 'end' }];
  return [{ d: Array.from({ length: n }, (_, i) => { const y = -22 + (i - (n - 1) / 2) * 4; return `M-4 ${y + 2}L4 ${y - 2}`; }).join('') }];
}
function barSymbol(s, p) {
  const n = Math.max(1, Math.min(40, parseInt(p.ways, 10) || 6)), x0 = -(n - 1) * 10;
  const pins = Array.from({ length: n }, (_, i) => ({ n: String(i + 1), x: x0 + i * 20, y: 20 }));
  const shapes = [{ d: `M${x0 - 10} -2h${(n - 1) * 20 + 20}v4h${-((n - 1) * 20 + 20)}z`, fill: true }, { d: pins.map((q) => `M${q.x} 2V20`).join('') }, ...pins.map((q) => ({ c: [q.x, 11, 2.2] })), { t: [x0 - 14, 0, s.bar, 9], anchor: 'end' }];
  return { ...s, pins, box: [x0 - 30, -6, -x0 + 10, 20], shapes };
}
export function symbolOf(part) {
  let s = S[part.sym];
  if (!s) throw new Error(`unknown symbol "${part.sym}"`);
  const poles = s.poleMark ? poleCount(part.props?.poles) : 0;
  if (s.sld && part.props?.poles != null && part.props.poles !== '') s = { ...s, ...s.sld };
  if (poles > 1) s = { ...s, shapes: [...s.shapes, ...poleTicks(poles)] };
  if (s.bar) return barSymbol(s, { ...s.props, ...part.props });
  if (!s.dynamic) return s;
  const p = { ...s.props, ...part.props };
  const L = list(p.left), R = list(p.right), T = list(p.top), B = list(p.bottom);
  const w = Math.max(60, snap((Math.max(T.length, B.length) + 1) * 20)), h = Math.max(40, snap((Math.max(L.length, R.length) + 1) * 20));
  // w and h are multiples of 20, so every pin (20px apart, starting 20px in from a corner) lands on the grid
  const pins = [];
  L.forEach((n, i) => pins.push({ n, x: -w / 2 - 10, y: -h / 2 + 20 * (i + 1) }));
  R.forEach((n, i) => pins.push({ n, x: w / 2 + 10, y: -h / 2 + 20 * (i + 1) }));
  T.forEach((n, i) => pins.push({ n, x: -w / 2 + 20 * (i + 1), y: -h / 2 - 10 }));
  B.forEach((n, i) => pins.push({ n, x: -w / 2 + 20 * (i + 1), y: h / 2 + 10 }));
  const ticks = pins.map((q) => (Math.abs(q.x) > w / 2 ? `M${q.x} ${q.y}H${Math.sign(q.x) * w / 2}` : `M${q.x} ${q.y}V${Math.sign(q.y) * h / 2}`)).join('');
  const shapes = [{ d: `M${-w / 2} ${-h / 2}h${w}v${h}h${-w}z${ticks}` }, { t: [0, 0, p.label || '', 10] }];
  for (const q of pins) {
    const side = Math.abs(q.x) > w / 2 ? (q.x < 0 ? 'l' : 'r') : (q.y < 0 ? 't' : 'b');
    const [tx, ty] = side === 'l' ? [q.x + 14, q.y] : side === 'r' ? [q.x - 14, q.y] : side === 't' ? [q.x, q.y + 15] : [q.x, q.y - 15];
    shapes.push({ t: [tx, ty, q.n, 7], anchor: side === 'l' ? 'start' : side === 'r' ? 'end' : 'middle' });
  }
  return { ...s, pins, box: [-w / 2 - 10, -h / 2 - 10, w / 2 + 10, h / 2 + 10], shapes };
}

// ---------- geometry ----------
// Local -> sheet coordinates: mirror (in x) first, then rotate clockwise by rot degrees, then translate.
export function xform(part, [x, y]) {
  if (part.mirror) x = -x;
  const r = ((part.rot || 0) % 360 + 360) % 360;
  const [a, b] = r === 90 ? [-y, x] : r === 180 ? [-x, -y] : r === 270 ? [y, -x] : [x, y];
  return [part.x + a, part.y + b];
}
export const pinsOf = (part) => symbolOf(part).pins.map((p) => { const [x, y] = xform(part, [p.x, p.y]); return { name: p.n, x: Math.round(x), y: Math.round(y) }; });
export function bboxOf(part) {
  const [x1, y1, x2, y2] = symbolOf(part).box;
  const c = [[x1, y1], [x2, y1], [x1, y2], [x2, y2]].map((p) => xform(part, p));
  return [Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))];
}
// Outward direction of a pin: the side of the symbol box it sits on.
function pinDir(part, pinName) {
  const sym = symbolOf(part), p = sym.pins.find((q) => q.n === pinName);
  const [x1, y1, x2, y2] = sym.box;
  const d = [[p.x - x1, [-1, 0]], [x2 - p.x, [1, 0]], [p.y - y1, [0, -1]], [y2 - p.y, [0, 1]]].sort((a, b) => a[0] - b[0])[0][1];
  const [ox, oy] = xform({ ...part, x: 0, y: 0 }, d);
  return [Math.round(ox), Math.round(oy)];
}
const key = (x, y) => `${x},${y}`;
const onSeg = ([x, y], [a, b], [c, d]) => (a === c ? x === a && y >= Math.min(b, d) && y <= Math.max(b, d) : b === d ? y === b && x >= Math.min(a, c) && x <= Math.max(a, c) : false);

// ---------- sheet sizes, frame, zones ----------
export const SIZES = { A4: [1190, 840], A3: [1680, 1190], A2: [2380, 1680], A1: [3360, 2380] };
export const ZONE = 200; // frame columns 1, 2, 3... and rows A, B, C... every 200px, for "K1 contact at 3.B" cross references
export function zoneOf(sheet, x, y) {
  const [w, h] = SIZES[sheet.size] || SIZES.A3;
  const c = Math.min(Math.max(1, Math.floor(x / ZONE) + 1), Math.ceil(w / ZONE)), r = Math.min(Math.max(0, Math.floor(y / ZONE)), Math.ceil(h / ZONE) - 1);
  return `${c}.${String.fromCharCode(65 + r)}`;
}

export const emptySheet = (id, name) => ({ id, name: name || `Sheet ${id}`, size: 'A3', title: {}, parts: [], wires: [], labels: [], rev: 0, nextId: 1 });
const newId = (sheet, p) => `${p}${sheet.nextId = (sheet.nextId || 1) + 1, sheet.nextId - 1}`;

// ---------- connectivity ----------
// Nets of one sheet: points that touch are joined (wire vertices, wire ends on another wire's segment, pins at wire
// vertices). Returns { nets: [{ id, name, named, nodes: ['K1:A1', ...], points }], pointNet: Map("x,y" -> net index),
// junctions: [[x,y]] }. globalNames: true when the name came from a net label or power symbol.
export function connectivity(sheet) {
  const parent = new Map();
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const add = (k) => { if (!parent.has(k)) parent.set(k, k); return k; };
  const join = (a, b) => { a = find(add(a)); b = find(add(b)); if (a !== b) parent.set(a, b); };
  const degree = new Map(); // wire ends/passes at each point, for junction dots
  const bump = (k, n) => degree.set(k, (degree.get(k) || 0) + n);
  const wires = sheet.wires.map((w) => ({ ...w, pts: simplify(w.pts) })); // tolerate repeated points from older edits
  for (const w of wires) {
    w.pts.forEach(([x, y], i) => { add(key(x, y)); if (i) join(key(x, y), key(...w.pts[i - 1])); bump(key(x, y), i === 0 || i === w.pts.length - 1 ? 1 : 2); });
  }
  const pins = [];
  for (const p of sheet.parts) for (const q of pinsOf(p)) { pins.push({ part: p, ...q }); bump(key(q.x, q.y), 1); }
  // ends and pins landing on the middle of a segment
  const probes = [...sheet.wires.flatMap((w) => [w.pts[0], w.pts.at(-1)]), ...pins.map((q) => [q.x, q.y]), ...sheet.labels.filter((l) => l.kind === 'net').map((l) => [l.x, l.y])];
  for (const w of wires) for (let i = 1; i < w.pts.length; i++) {
    const a = w.pts[i - 1], b = w.pts[i];
    for (const pt of probes) {
      if (!onSeg(pt, a, b)) continue;
      const k = key(...pt);
      if (k === key(...a) || k === key(...b)) continue;
      join(k, key(...a)); bump(k, 2);
    }
  }
  for (const q of pins) add(key(q.x, q.y));
  // power symbols and net labels give names
  const names = new Map();
  for (const q of pins) { const sym = symbolOf(q.part); if (sym.power) names.set(find(key(q.x, q.y)), q.part.props?.net || sym.power); }
  for (const l of sheet.labels) if (l.kind === 'net' && parent.has(key(l.x, l.y))) names.set(find(key(l.x, l.y)), l.text);
  const groups = new Map();
  for (const k of parent.keys()) { const r = find(k); if (!groups.has(r)) groups.set(r, { points: [], nodes: [] }); groups.get(r).points.push(k); }
  for (const q of pins) if (!symbolOf(q.part).power) groups.get(find(key(q.x, q.y))).nodes.push(`${q.part.ref}:${q.name}`);
  const nets = [], pointNet = new Map();
  let n = 0;
  for (const [r, g] of groups) {
    const name = names.get(r);
    const wired = g.points.length > 1 || name;
    if (!wired && g.nodes.length < 2) continue; // a lone unconnected pin is not a net
    const i = nets.length;
    nets.push({ id: i, name: name || `N${String(++n).padStart(3, '0')}`, named: !!name, nodes: [...new Set(g.nodes)].sort(), points: g.points });
    g.points.forEach((k) => pointNet.set(k, i));
  }
  const junctions = [...degree].filter(([k, d]) => d >= 3 && pointNet.has(k)).map(([k]) => k.split(',').map(Number));
  return { nets, pointNet, junctions };
}

// Whole-project netlist: named nets with the same name join across sheets. [{ name, nodes: ['K1:A1'], sheets: [names] }]
export function netlist(sheets) {
  const out = new Map();
  for (const sh of sheets) for (const n of connectivity(sh).nets) {
    const k = n.named ? n.name : `${sh.name}/${n.name}`;
    if (!out.has(k)) out.set(k, { name: k, nodes: new Set(), sheets: new Set() });
    n.nodes.forEach((x) => out.get(k).nodes.add(fullRef(sh, x))); out.get(k).sheets.add(sh.name);
  }
  return [...out.values()].map((n) => ({ name: n.name, nodes: [...n.nodes].sort(), sheets: [...n.sheets] })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// Bill of materials across sheets: one line per distinct (symbol, value, part number), contacts folded into their device.
export function bom(sheets) {
  const rows = new Map();
  for (const sh of sheets) for (const p of sh.parts) {
    const sym = symbolOf(p);
    if (sym.power || sym.contact) continue;
    const v = p.props?.value ?? '', pn = p.props?.partNo ?? '', mf = p.props?.maker ?? '';
    const k = [p.sym, v, pn, mf].join('|');
    if (!rows.has(k)) rows.set(k, { refs: new Set(), symbol: sym.name, value: v, partNo: pn, maker: mf, description: p.props?.description ?? '' });
    rows.get(k).refs.add(fullRef(sh, p.ref));
  }
  // cables named on circuits (props.cable), one line per type with the total length
  const cables = new Map();
  for (const sh of sheets) for (const p of sh.parts) {
    const c = p.props?.cable; if (!c) continue;
    if (!cables.has(c)) cables.set(c, { refs: new Set(), symbol: 'Cable', value: c, partNo: '', maker: '', len: 0 });
    cables.get(c).refs.add(fullRef(sh, p.ref)); cables.get(c).len += parseFloat(p.props.length) || 0;
  }
  for (const [c, r] of cables) rows.set(`cable|${c}`, { ...r, description: r.len ? `total ${r.len} m` : 'length not given', cable: true });
  return [...rows.values()].map(({ len, ...r }) => ({ ...r, qty: r.refs.size, refs: [...r.refs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) }))
    .sort((a, b) => (a.cable || 0) - (b.cable || 0) || a.refs[0].localeCompare(b.refs[0], undefined, { numeric: true }));
}
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const bomCsv = (sheets) => ['Qty,Refs,Symbol,Value,Part number,Maker,Description', ...bom(sheets).map((r) => [r.qty, r.refs.join(' '), r.symbol, r.value, r.partNo, r.maker, r.description].map(csvCell).join(','))].join('\n') + '\n';
export const netlistCsv = (sheets) => ['Net,Node,Sheets', ...netlist(sheets).flatMap((n) => n.nodes.map((x) => [n.name, x, n.sheets.join(' ')].map(csvCell).join(',')))].join('\n') + '\n';

// Circuit schedule: every part with circuit/cable/phase props (normally the outgoing breakers), with the load it feeds.
const CIRCUIT_PROPS = ['circuit', 'cable', 'phase'];
export const CIRCUIT_COLS = [['circuit', 'Circuit'], ['ref', 'Device'], ['device', 'Rating'], ['cable', 'Cable'], ['length', 'Length'], ['phase', 'Phase'], ['power', 'Power'], ['load', 'Load']];
export function circuits(sheets) {
  const rows = [];
  for (const sh of sheets) {
    let conn = null;
    for (const p of sh.parts) {
      const pr = p.props || {};
      if (!CIRCUIT_PROPS.some((k) => pr[k])) continue;
      let load = pr.load || '';
      if (!load) { // the load part this circuit feeds: on the nets of its pins other than the first
        conn ||= connectivity(sh);
        const mine = new Set(pinsOf(p).slice(1).map((q) => conn.pointNet.get(key(q.x, q.y))).filter((x) => x != null));
        const refs = [...mine].flatMap((i) => conn.nets[i].nodes.map((n) => n.split(':')[0])).filter((r) => r !== p.ref);
        const cand = refs.map((r) => sh.parts.find((x) => x.ref === r)).filter(Boolean).sort((a, b) => (symbolOf(b).cat === 'Loads') - (symbolOf(a).cat === 'Loads'))[0];
        if (cand) load = cand.props?.description || cand.props?.value || symbolOf(cand).name;
      }
      rows.push({ sheet: sh.name, circuit: pr.circuit || '', ref: fullRef(sh, p.ref), device: pr.value || '', cable: pr.cable || '', length: pr.length || '', phase: pr.phase || '', power: pr.power || '', load });
    }
  }
  return rows.sort((a, b) => String(a.circuit).localeCompare(String(b.circuit), undefined, { numeric: true }) || a.ref.localeCompare(b.ref, undefined, { numeric: true }));
}
export const circuitsCsv = (sheets) => [['Sheet', ...CIRCUIT_COLS.map((c) => c[1])].join(','), ...circuits(sheets).map((r) => [r.sheet, ...CIRCUIT_COLS.map(([k]) => r[k])].map(csvCell).join(','))].join('\n') + '\n';
// "2kW" / "1500 W" / "1.5" (kW) -> watts
const watts = (v) => { const m = /([\d.]+)\s*(k|M)?W?/i.exec(String(v ?? '')); if (!m) return 0; const n = +m[1]; return /W/i.test(v) ? n * (m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1) : n * 1e3; };
// Per-phase load of a sheet from the circuits' phase + power props. A 3-phase circuit (phase "L1L2L3" or "3P") counts a third on each.
export function phaseLoads(sheet) {
  const t = { L1: 0, L2: 0, L3: 0 };
  let n = 0;
  for (const r of circuits([sheet])) {
    const w = watts(r.power); if (!w || !r.phase) continue;
    let ph = String(r.phase).toUpperCase().match(/L[123]/g) || [];
    if (!ph.length && /3/.test(r.phase)) ph = ['L1', 'L2', 'L3'];
    ph = [...new Set(ph)]; if (!ph.length) continue;
    ph.forEach((x) => { t[x] += w / ph.length; }); n++;
  }
  return n ? t : null;
}
const kw = (w) => `${(w / 1000).toFixed(1)}kW`;

// Approximate boxes of a part's own text (ref, value, cable block), for overlap checks.
const textW = (t, size) => String(t).length * size * 0.6;
export function textBoxes(p) {
  return partTexts(p).map((t) => { const w = textW(t.text, t.size), x0 = t.anchor === 'end' ? t.x - w : t.anchor === 'middle' ? t.x - w / 2 : t.x; return { text: t.text, box: [x0, t.y - t.size / 2, x0 + w, t.y + t.size / 2] }; });
}
const overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

// Sheet issues Claude and the user should know about.
export function check(sheet, sheets = [sheet]) {
  const out = [];
  const { nets } = connectivity(sheet);
  const touched = new Set(nets.flatMap((n) => n.points));
  for (const p of sheet.parts) {
    const sym = symbolOf(p);
    for (const q of pinsOf(p)) if (!touched.has(key(q.x, q.y))) out.push(`${p.ref}:${q.name} is not connected`);
    if (!sym.power && !sym.contact) {
      const dup = peers(sheets, sheet).flatMap((s) => s.parts).filter((o) => o !== p && o.id !== p.id && o.ref === p.ref && !symbolOf(o).contact);
      if (dup.length) out.push(`${p.ref} is used by more than one device`);
    }
    if (sym.contact && !refTaken(sheets, sheet, p.ref)) out.push(`contact ${p.ref} has no coil/device ${p.ref}`);
  }
  for (const w of sheet.wires) for (let i = 1; i < w.pts.length; i++) { const [a, b] = w.pts[i - 1], [c, d] = w.pts[i]; if (a !== c && b !== d) { out.push(`wire ${w.id} has a diagonal segment`); break; } }
  for (const n of nets) if (n.nodes.length === 1 && !n.named) out.push(`net ${n.name} only reaches ${n.nodes[0]}`);
  // ponytail: O(n^2) over parts, fine for a few hundred per sheet; grid-bucket it if sheets get much bigger
  const tb = sheet.parts.filter((p) => !symbolOf(p).power).map((p) => ({ p, boxes: textBoxes(p), bbox: bboxOf(p) }));
  for (const a of tb) for (const t of a.boxes) for (const b of tb) {
    if (b === a) continue;
    if (overlap(t.box, b.bbox)) { out.push(`${a.p.ref} text "${t.text}" overlaps ${b.p.ref}`); continue; }
    if (b.p.id < a.p.id && b.boxes.some((u) => overlap(t.box, u.box))) out.push(`${a.p.ref} text "${t.text}" overlaps the text of ${b.p.ref}`);
  }
  const ph = phaseLoads(sheet);
  if (ph) { const v = Object.values(ph), hi = Math.max(...v), lo = Math.min(...v); if (hi > 0 && (hi - lo) / hi > 0.2) out.push(`phase imbalance: L1 ${kw(ph.L1)}, L2 ${kw(ph.L2)}, L3 ${kw(ph.L3)} (${Math.round((hi - lo) / hi * 100)}% between the highest and lowest)`); }
  return [...new Set(out)];
}

// Pin names as contact pairs: [1,3,5,2,4,6] -> "1-2 3-4 5-6", [13,14] -> "13-14".
const pairs = (n) => n.slice(0, n.length / 2).map((a, i) => `${a}-${n[i + n.length / 2]}`).join(' ');
// Cross references, keyed by full designation: for each coil/device, where its contacts are (zone), and for each contact, where its coil is.
export function crossRefs(sheets) {
  const where = {};
  for (const sh of sheets) for (const p of sh.parts) {
    const sym = symbolOf(p);
    if (sym.power) continue;
    const r = fullRef(sh, p.ref);
    (where[r] ||= { device: null, contacts: [] });
    const loc = `${sheets.length > 1 ? sh.id + '/' : ''}${zoneOf(sh, p.x, p.y)}`;
    if (sym.contact) where[r].contacts.push({ id: p.id, sheet: sh.id, loc, kind: p.sym === 'contact_nc' ? 'NC' : 'NO', pins: pairs(pinsOf(p).map((q) => q.name)) });
    else where[r].device = { id: p.id, sheet: sh.id, loc };
  }
  return where;
}

// ---------- designators ----------
// Sheets sharing a designation prefix (sheet.refPrefix, e.g. "=MDB2") number their parts together; other prefixes start again at 1.
export const scopeOf = (sheet) => String(sheet?.refPrefix ?? '');
export const peers = (sheets, sheet) => (sheet ? [...sheets.filter((s) => s !== sheet && s.id !== sheet.id), sheet].filter((s) => scopeOf(s) === scopeOf(sheet)) : sheets);
// The full designation: "=MDB2-Q1" on a sheet with refPrefix "=MDB2", plain "Q1" otherwise.
export const fullRef = (sheet, ref) => (scopeOf(sheet) ? `${scopeOf(sheet)}${String(ref).startsWith('-') ? '' : '-'}${ref}` : String(ref));
export function nextRef(sheets, prefix, sheet) {
  let n = 0;
  const re = new RegExp(`^-?${prefix}(\\d+)$`);
  for (const sh of peers(sheets, sheet)) for (const p of sh.parts) { const m = re.exec(p.ref || ''); if (m) n = Math.max(n, +m[1]); }
  return `${prefix}${n + 1}`;
}
const isDevice = (p) => { const y = symbolOf(p); return !y.power && !y.contact; };
const refTaken = (sheets, sheet, ref) => peers(sheets, sheet).some((s) => s.parts.some((p) => p.ref === ref && isDevice(p)));

// ---------- editing ----------
// Moves parts by (dx, dy), dragging the wire vertices that sat on their pins (and keeping the next segment orthogonal).
export function moveParts(sheet, ids, dx, dy) {
  if (!dx && !dy) return;
  const set = new Set(ids);
  const pts = new Set(sheet.parts.filter((p) => set.has(p.id)).flatMap((p) => pinsOf(p).map((q) => key(q.x, q.y))));
  for (const p of sheet.parts) if (set.has(p.id)) { p.x += dx; p.y += dy; }
  for (const w of sheet.wires) dragWire(w, pts, dx, dy);
}
function dragWire(w, pts, dx, dy) {
  const n = w.pts.length;
  const hit = w.pts.map(([x, y]) => pts.has(key(x, y)));
  if (!hit.some(Boolean)) return;
  if (hit.every(Boolean)) { w.pts = w.pts.map(([x, y]) => [x + dx, y + dy]); return; }
  for (const end of [0, n - 1]) {
    if (!hit[end]) continue;
    const nb = end === 0 ? 1 : n - 2;
    const [x, y] = w.pts[end], [nx, ny] = w.pts[nb];
    w.pts[end] = [x + dx, y + dy];
    if (n === 2) { // a straight wire becomes an L (or Z) so it stays orthogonal
      const [ox, oy] = w.pts[nb === 1 ? 1 : 0];
      const moved = w.pts[end];
      if (moved[0] !== ox && moved[1] !== oy) {
        const mid = x === nx ? [[moved[0], (moved[1] + oy) / 2 | 0], [ox, (moved[1] + oy) / 2 | 0]] : [[(moved[0] + ox) / 2 | 0, moved[1]], [(moved[0] + ox) / 2 | 0, oy]];
        const m = mid.map(([a, b]) => [snap(a), snap(b)]);
        w.pts = simplify(end === 0 ? [moved, ...m, [ox, oy]] : [[ox, oy], ...m.reverse(), moved]);
        return;
      }
      continue;
    }
    if (!hit[nb]) w.pts[nb] = x === nx ? [nx + dx, ny] : [nx, ny + dy];
  }
  w.pts = simplify(w.pts);
}
// Rotates (by 90 steps) and/or mirrors parts in place; wire ends on a pin follow that pin to its new spot.
export function turnParts(sheet, ids, { rot = 0, mirror = false } = {}) {
  const set = new Set(ids);
  for (const p of sheet.parts) {
    if (!set.has(p.id)) continue;
    const before = pinsOf(p);
    p.rot = ((p.rot || 0) + rot + 360) % 360;
    if (mirror) p.mirror = !p.mirror;
    const after = Object.fromEntries(pinsOf(p).map((q) => [q.name, q]));
    const moves = new Map(before.map((q) => [key(q.x, q.y), after[q.name]]));
    for (const w of sheet.wires) for (const end of [0, w.pts.length - 1]) {
      const to = moves.get(key(...w.pts[end]));
      if (!to) continue;
      const nb = end === 0 ? 1 : w.pts.length - 2;
      const [nx, ny] = w.pts[nb];
      w.pts[end] = [to.x, to.y];
      if (to.x !== nx && to.y !== ny) w.pts.splice(end === 0 ? 1 : w.pts.length - 1, 0, [to.x, ny]);
      w.pts = simplify(w.pts);
    }
  }
}
// Deletes parts, wires and labels by id.
export function removeItems(sheet, ids) {
  const set = new Set(ids);
  for (const k of ['parts', 'wires', 'labels']) sheet[k] = sheet[k].filter((x) => !set.has(x.id));
}
// Copies items, offset by (dx, dy); new parts get fresh designators unless they are power symbols or contacts. Returns new ids.
export function duplicate(sheet, ids, dx, dy, sheets = [sheet]) {
  const set = new Set(ids), out = [];
  for (const p of sheet.parts.filter((x) => set.has(x.id))) {
    const sym = symbolOf(p);
    const n = { ...structuredClone(p), id: newId(sheet, 'p'), x: p.x + dx, y: p.y + dy, ref: sym.power || sym.contact ? p.ref : nextRef(sheets, sym.prefix, sheet) };
    sheet.parts.push(n); out.push(n.id);
  }
  for (const w of sheet.wires.filter((x) => set.has(x.id))) { const n = { ...structuredClone(w), id: newId(sheet, 'w'), pts: w.pts.map(([x, y]) => [x + dx, y + dy]) }; sheet.wires.push(n); out.push(n.id); }
  for (const l of sheet.labels.filter((x) => set.has(x.id))) { const n = { ...l, id: newId(sheet, 'l'), x: l.x + dx, y: l.y + dy }; sheet.labels.push(n); out.push(n.id); }
  return out;
}
export const addPart = (sheet, sym, x, y, rot = 0, sheets = [sheet]) => applyOps(sheet, [{ op: 'add', sym, x, y, rot }], sheets).added[0]?.split('=')[0];
export const addWire = (sheet, pts, kind) => applyOps(sheet, [{ op: 'wire', pts, kind }]).added[0];
export const addLabel = (sheet, text, x, y, kind = 'net') => applyOps(sheet, [{ op: 'label', text, x, y, kind }]).added[0];
export { key as ptKey };

// Drops repeated and collinear middle points.
export function simplify(pts) {
  const p = pts.filter((q, i) => i === 0 || q[0] !== pts[i - 1][0] || q[1] !== pts[i - 1][1]);
  return p.filter((q, i) => i === 0 || i === p.length - 1 || !((p[i - 1][0] === q[0] && q[0] === p[i + 1][0]) || (p[i - 1][1] === q[1] && q[1] === p[i + 1][1])));
}

// Orthogonal route from a to b. da/db: outward pin directions ([0,0] for a free point); via: points to pass through.
export function route(a, b, da = [0, 0], db = [0, 0], via = []) {
  const A1 = [a[0] + da[0] * 20, a[1] + da[1] * 20], B1 = [b[0] + db[0] * 20, b[1] + db[1] * 20];
  const stops = [A1, ...via, B1];
  const pts = [a];
  for (let i = 0; i < stops.length; i++) {
    const from = pts.at(-1), to = stops[i];
    const vertFirst = i === 0 ? da[1] !== 0 || (!da[0] && Math.abs(to[1] - from[1]) > Math.abs(to[0] - from[0])) : false;
    if (from[0] !== to[0] && from[1] !== to[1]) pts.push(vertFirst ? [from[0], to[1]] : [to[0], from[1]]);
    pts.push(to);
  }
  // last leg into b along its pin direction
  const last = pts.at(-1);
  if (db[1] !== 0 && last[0] !== b[0]) pts.push([b[0], last[1]]);
  else if (db[0] !== 0 && last[1] !== b[1]) pts.push([last[0], b[1]]);
  else if (!db[0] && !db[1] && last[0] !== b[0] && last[1] !== b[1]) pts.push([b[0], last[1]]);
  pts.push(b);
  // pull the stubs back when they are not needed (pins facing each other on one line)
  return simplify(pts.map(([x, y]) => [snap(x), snap(y)]));
}

// "K1:A1" (or a part id "p3:A1") -> { x, y, dir }. Several parts may share a ref; the pin name picks the right one.
export function findPin(sheet, ref) {
  if (Array.isArray(ref)) return { x: snap(ref[0]), y: snap(ref[1]), dir: [0, 0] };
  const m = /^(.+?)[:.]([^:.]+)$/.exec(String(ref));
  if (!m) throw new Error(`pin "${ref}" must look like REF:PIN, e.g. K1:A1, or be a point [x, y]`);
  const [, r, pin] = m;
  const parts = sheet.parts.filter((p) => p.ref === r || p.id === r);
  if (!parts.length) throw new Error(`no part "${r}" on sheet "${sheet.name}"`);
  for (const p of parts) {
    const q = pinsOf(p).find((x) => x.name === pin);
    if (q) return { x: q.x, y: q.y, dir: pinDir(p, pin), part: p };
  }
  throw new Error(`${r} has no pin "${pin}"; pins: ${[...new Set(parts.flatMap((p) => pinsOf(p).map((q) => q.name)))].join(', ')}`);
}

const findItem = (sheet, ref) => {
  const r = String(ref);
  const p = sheet.parts.filter((x) => x.id === r || x.ref === r);
  if (p.length > 1 && !p.some((x) => x.id === r)) throw new Error(`"${r}" is used by ${p.length} parts (${p.map((x) => `${x.id} ${x.sym}`).join(', ')}); use the id`);
  if (p.length) return ['parts', p.find((x) => x.id === r) || p[0]];
  for (const k of ['wires', 'labels']) { const x = sheet[k].find((y) => y.id === r); if (x) return [k, x]; }
  throw new Error(`no part, wire or label "${r}" on sheet "${sheet.name}"`);
};
const onGrid = (v, what) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${what} must be a number`); return snap(n); };
const ROT = (r) => { const n = ((Math.round(Number(r || 0) / 90) * 90) % 360 + 360) % 360; return n; };

// One copy of an array's sub-op: points shifted by (dx, dy), "{i}" in strings -> the copy number, "$j" -> what sub-op j of this copy added.
function shiftOp(o, dx, dy, n, made) {
  const str = (v) => (typeof v === 'string' ? v.replace(/\{i\}/g, n).replace(/\$(\d+)/g, (m, j) => made[j] ?? m) : v);
  const pt = (q) => (Array.isArray(q) ? [q[0] + dx, q[1] + dy] : str(q));
  const out = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, str(v)]));
  if (o.x != null) out.x = Number(o.x) + dx;
  if (o.y != null) out.y = Number(o.y) + dy;
  for (const k of ['pts', 'via']) if (o[k]) out[k] = o[k].map(pt);
  for (const k of ['from', 'to']) if (o[k] != null) out[k] = pt(o[k]);
  if (o.props) out.props = Object.fromEntries(Object.entries(o.props).map(([k, v]) => [k, str(v)]));
  return out;
}
// Applies edit ops to a sheet in place. sheets: all sheets (for designators). Returns { added: [ids], errors, warnings }.
// Ops: add {sym, ref?, x, y, rot?, mirror?, props?} | update {id|ref, x?, y?, rot?, mirror?, ref?, props?} (props merge; null deletes a prop)
// | delete {id|ref} | wire {pts, kind?} | connect {from, to, via?, kind?} | label {text, x, y, kind?} | sheet {name?, size?, title?}
export function applyOps(sheet, ops, sheets = [sheet]) {
  const res = { added: [], errors: [], warnings: [] };
  ops.forEach((o, i) => {
    try {
      if (o.op === 'array') {
        const count = Math.min(200, Math.max(0, parseInt(o.count, 10) || 0)), dx = Number(o.dx) || 0, dy = Number(o.dy) || 0, start = parseInt(o.start ?? 1, 10);
        if (!count || !Array.isArray(o.ops)) throw new Error('array needs count and ops');
        for (let k = 0; k < count; k++) {
          const made = [];
          o.ops.forEach((sub, j) => {
            const r = applyOps(sheet, [shiftOp(sub, k * dx, k * dy, k + start, made)], sheets);
            made[j] = r.added[0]?.split('=').at(-1);
            res.added.push(...r.added);
            r.errors.forEach((e) => res.errors.push(`op ${i} (array #${k + start}) ${e}`));
            r.warnings.forEach((e) => res.warnings.push(`op ${i} (array #${k + start}) ${e}`));
          });
        }
      } else if (o.op === 'add') {
        const sym = S[o.sym];
        if (!sym) throw new Error(`unknown symbol "${o.sym}"; call list_symbols`);
        const props = { ...(sym.props || {}), ...(sym.value != null ? { value: sym.value } : {}), ...(sym.power ? { net: sym.power } : {}), ...(o.props || {}) };
        let ref = o.ref ? String(o.ref) : sym.power ? props.net : nextRef(sheets, sym.prefix, sheet);
        // a device designator is unique within its prefix scope: a taken one is renumbered rather than duplicated
        if (o.ref && !sym.power && !sym.contact && refTaken(sheets, sheet, ref)) {
          const m = /^(-?)([A-Z]+)\d*$/i.exec(ref);
          const fresh = m ? m[1] + nextRef(sheets, m[2], sheet) : nextRef(sheets, sym.prefix, sheet);
          res.warnings.push(`op ${i}: ${ref} is taken${scopeOf(sheet) ? ` in ${scopeOf(sheet)}` : ''}, used ${fresh} (set the sheet's refPrefix to number each board on its own)`);
          ref = fresh;
        }
        const part = { id: newId(sheet, 'p'), ref, sym: o.sym, x: onGrid(o.x, 'x'), y: onGrid(o.y, 'y'), rot: ROT(o.rot), mirror: !!o.mirror, props };
        sheet.parts.push(part); res.added.push(`${part.id}=${ref}`);
      } else if (o.op === 'update') {
        const [kind, it] = findItem(sheet, o.id ?? o.ref);
        if (kind === 'parts') {
          if (o.x != null || o.y != null) moveParts(sheet, [it.id], (o.x != null ? onGrid(o.x, 'x') : it.x) - it.x, (o.y != null ? onGrid(o.y, 'y') : it.y) - it.y);
          if (o.rot != null) it.rot = ROT(o.rot);
          if (o.mirror != null) it.mirror = !!o.mirror;
          if (o.newRef) it.ref = String(o.newRef);
          if (o.sym) { if (!S[o.sym]) throw new Error(`unknown symbol "${o.sym}"`); it.sym = o.sym; }
          if (o.props) for (const [k, v] of Object.entries(o.props)) { if (v == null) delete it.props[k]; else it.props[k] = v; }
        } else if (kind === 'wires') {
          if (o.pts) it.pts = simplify(o.pts.map(([x, y]) => [onGrid(x, 'x'), onGrid(y, 'y')]));
          if (o.kind !== undefined) { if (o.kind) it.kind = o.kind; else delete it.kind; }
          if (o.label !== undefined) { if (o.label) it.label = String(o.label); else delete it.label; }
        } else {
          for (const k of ['text', 'kind', 'rows', 'cols', 'auto', 'dash']) if (o[k] != null) it[k] = o[k];
          for (const k of ['w', 'h']) if (o[k] != null) it[k] = onGrid(o[k], k);
          if (o.x != null) it.x = onGrid(o.x, 'x');
          if (o.y != null) it.y = onGrid(o.y, 'y');
        }
      } else if (o.op === 'delete') {
        const [kind, it] = findItem(sheet, o.id ?? o.ref);
        sheet[kind] = sheet[kind].filter((x) => x !== it);
      } else if (o.op === 'wire') {
        if (!Array.isArray(o.pts) || o.pts.length < 2) throw new Error('wire needs pts: [[x,y], [x,y], ...]');
        const pts = simplify(o.pts.map(([x, y]) => [onGrid(x, 'x'), onGrid(y, 'y')]));
        const w = { id: newId(sheet, 'w'), pts, ...(o.kind ? { kind: o.kind } : {}), ...(o.label ? { label: String(o.label) } : {}) };
        sheet.wires.push(w); res.added.push(w.id);
        if (pts.some((p, j) => j && p[0] !== pts[j - 1][0] && p[1] !== pts[j - 1][1])) res.warnings.push(`op ${i}: ${w.id} has a diagonal segment`);
      } else if (o.op === 'connect') {
        const a = findPin(sheet, o.from), b = findPin(sheet, o.to);
        const via = (o.via || []).map(([x, y]) => [onGrid(x, 'x'), onGrid(y, 'y')]);
        const w = { id: newId(sheet, 'w'), pts: route([a.x, a.y], [b.x, b.y], a.dir, b.dir, via), ...(o.kind ? { kind: o.kind } : {}) };
        sheet.wires.push(w); res.added.push(w.id);
      } else if (o.op === 'rect') { // board enclosure / frame: dashed unless dash:false, label drawn at the top left
        const l = { id: newId(sheet, 'l'), kind: 'rect', text: String(o.text ?? o.label ?? ''), x: onGrid(o.x, 'x'), y: onGrid(o.y, 'y'), w: onGrid(o.w, 'w'), h: onGrid(o.h, 'h'), dash: o.dash !== false };
        if (l.w <= 0 || l.h <= 0) throw new Error('rect needs w and h > 0');
        sheet.labels.push(l); res.added.push(l.id);
      } else if (o.op === 'table') { // auto:"circuits" lists this sheet's circuits; or cols + rows of cells
        const l = { id: newId(sheet, 'l'), kind: 'table', text: String(o.text ?? o.title ?? ''), x: onGrid(o.x, 'x'), y: onGrid(o.y, 'y') };
        if (o.auto) { if (o.auto !== 'circuits') throw new Error('auto must be "circuits"'); l.auto = 'circuits'; }
        else { if (!Array.isArray(o.rows)) throw new Error('table needs rows: [[cell, ...], ...] (or auto: "circuits")'); l.cols = (o.cols || []).map(String); l.rows = o.rows.map((r) => r.map((c) => String(c ?? ''))); }
        sheet.labels.push(l); res.added.push(l.id);
      } else if (o.op === 'label') {
        const l = { id: newId(sheet, 'l'), kind: o.kind === 'text' ? 'text' : 'net', text: String(o.text ?? ''), x: onGrid(o.x, 'x'), y: onGrid(o.y, 'y') };
        if (!l.text) throw new Error('label needs text');
        sheet.labels.push(l); res.added.push(l.id);
      } else if (o.op === 'sheet') {
        if (o.name) sheet.name = String(o.name);
        if (o.size) { if (!SIZES[o.size]) throw new Error(`size must be one of ${Object.keys(SIZES).join(', ')}`); sheet.size = o.size; }
        if (o.title) sheet.title = { ...sheet.title, ...o.title };
        if (o.refPrefix != null) { if (o.refPrefix) sheet.refPrefix = String(o.refPrefix); else delete sheet.refPrefix; }
      } else throw new Error(`unknown op "${o.op}"`);
    } catch (e) { res.errors.push(`op ${i} (${o.op}): ${e.message}`); }
  });
  return res;
}

// What Claude reads: parts with absolute pin positions and the net on each pin, wires, labels, nets and issues.
export function describe(sheet, sheets = [sheet]) {
  const { nets, pointNet } = connectivity(sheet);
  const netAt = (x, y) => { const i = pointNet.get(key(x, y)); return i == null ? null : nets[i].name; };
  const xr = crossRefs(sheets);
  return {
    id: sheet.id, name: sheet.name, size: sheet.size, extent: SIZES[sheet.size] || SIZES.A3, title: sheet.title,
    parts: sheet.parts.map((p) => ({
      id: p.id, ref: p.ref, sym: p.sym, x: p.x, y: p.y, ...(p.rot ? { rot: p.rot } : {}), ...(p.mirror ? { mirror: true } : {}), props: p.props,
      zone: zoneOf(sheet, p.x, p.y), bbox: bboxOf(p),
      pins: Object.fromEntries(pinsOf(p).map((q) => [q.name, { at: [q.x, q.y], net: netAt(q.x, q.y) }])),
      ...(symbolOf(p).contact && xr[fullRef(sheet, p.ref)]?.device ? { coilAt: xr[fullRef(sheet, p.ref)].device.loc } : {}),
    })),
    wires: sheet.wires.map((w) => ({ id: w.id, pts: w.pts, net: netAt(...w.pts[0]), ...(w.kind ? { kind: w.kind } : {}), ...(w.label ? { label: w.label } : {}) })),
    labels: sheet.labels.map((l) => ({ ...l, bbox: labelBox(l, sheet) })),
    ...(sheet.refPrefix ? { refPrefix: sheet.refPrefix } : {}),
    ...(phaseLoads(sheet) ? { phaseLoads: Object.fromEntries(Object.entries(phaseLoads(sheet)).map(([k, v]) => [k, kw(v)])) } : {}),
    nets: nets.map((n) => ({ name: n.name, nodes: n.nodes })),
    issues: check(sheet, sheets),
  };
}

// ---------- rendering (SVG markup, for the editor and for PNG/SVG export) ----------
export const LIGHT = { bg: '#ffffff', ink: '#1d2330', wire: '#1f4fbf', bus: '#1f4fbf', text: '#1d2330', muted: '#7a8294', frame: '#9aa1b0', pin: '#d0453b', junction: '#1f4fbf', grid: '#e6e8ee', label: '#1d7a46' };
export const DARK = { bg: '#14161c', ink: '#d9dde6', wire: '#6f9bff', bus: '#6f9bff', text: '#d9dde6', muted: '#858c9c', frame: '#5b6272', pin: '#ef6b62', junction: '#6f9bff', grid: '#22252e', label: '#4cc38a' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FONT = 'font-family="DejaVu Sans, Arial, Helvetica, sans-serif"';

// ---------- text: units and right-to-left scripts ----------
// "2.5mm2" -> "2.5mm²", "10kohm" -> "10kΩ" (display only; the stored value keeps what was typed)
export const units = (v) => String(v ?? '').replace(/(\d)\s*mm2\b/g, '$1mm²').replace(/(\d)\s*([kM]?)ohms?\b/gi, '$1$2Ω');
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };
// Text in visual (left-to-right display) order, a reduced Unicode bidi algorithm: the paragraph direction is that of the first
// strong character; Hebrew/Arabic runs are reversed, Latin and digit runs inside them keep their order ("רשת 3x400/230V").
// The rasteriser (resvg) does no bidi at all, so both it and the browser get this string with bidi-override.
export function visual(s) {
  s = String(s);
  if (!RTL.test(s)) return s;
  const ch = [...s];
  const cls = ch.map((c) => (RTL.test(c) ? 'R' : /[\p{L}\p{N}]/u.test(c) ? 'L' : 'N'));
  const rtl = (cls.find((c) => c !== 'N') || 'R') === 'R';
  // bracket pairs (rule N0): both brackets take the paragraph direction if it occurs inside them (digits count as R),
  // otherwise the direction inside when the text before the pair has that direction too
  const open = [];
  ch.forEach((c, i) => {
    if ('([{'.includes(c)) open.push(i);
    else if (')]}'.includes(c)) {
      const o = open.findLastIndex((k) => ch[k] === { ')': '(', ']': '[', '}': '{' }[c]); if (o < 0) return;
      const k = open[o]; open.length = o;
      const inner = ch.slice(k + 1, i), e = rtl ? 'R' : 'L';
      const has = (d) => inner.some((x) => (d === 'R' ? RTL.test(x) || /\p{N}/u.test(x) : /\p{L}/u.test(x) && !RTL.test(x)));
      let d = null;
      if (has(e)) d = e;
      else if (has(e === 'R' ? 'L' : 'R')) { let before = e; for (let j = k - 1; j >= 0; j--) if (cls[j] !== 'N') { before = cls[j]; break; } d = before === e ? e : before; }
      if (d) cls[k] = cls[i] = d;
    }
  });
  const strong = (i, d) => { for (let j = i + d; j >= 0 && j < ch.length; j += d) if (cls[j] !== 'N') return cls[j]; return rtl ? 'R' : 'L'; };
  const lvl = cls.map((c, i) => { const k = c === 'N' ? (strong(i, -1) === strong(i, 1) ? strong(i, -1) : rtl ? 'R' : 'L') : c; return rtl ? (k === 'R' ? 1 : 2) : (k === 'R' ? 1 : 0); });
  const out = ch.map((c, i) => (lvl[i] % 2 && MIRROR[c] ? MIRROR[c] : c));
  for (let L = Math.max(...lvl); L >= 1; L--) {
    for (let i = 0; i < out.length;) {
      if (lvl[i] < L) { i++; continue; }
      let j = i; while (j < out.length && lvl[j] >= L) j++;
      out.splice(i, j - i, ...out.slice(i, j).reverse()); lvl.splice(i, j - i, ...lvl.slice(i, j).reverse());
      i = j;
    }
  }
  return out.join('');
}
// One <text>: escaped, units shown, RTL put in visual order. attrs: extra attributes (fill, text-anchor...).
const T = (x, y, str, size, attrs = '') => {
  const t = units(str), v = visual(t);
  // LRO ... PDF inside the text too: resvg ignores the unicode-bidi attribute but honours the control characters
  return `<text x="${x}" y="${y}" ${FONT} font-size="${size}" ${attrs}${v !== t ? ' direction="ltr" unicode-bidi="bidi-override"' : ''}>${v !== t ? `\u202D${esc(v)}\u202C` : esc(v)}</text>`;
};

// The text beside a part: power symbols show their net; others ref + value (right of the part, or below with props.labelPos
// "below", left with "left"), and a circuit block (circuit · phase, cable length) beside the outgoing pin.
export function partTexts(p) {
  const sym = symbolOf(p), pr = p.props || {};
  const [x1, y1, x2, y2] = bboxOf(p);
  if (sym.power) {
    const [nx, ny] = sym.netText ? xform(p, sym.netText) : [x2 + 4, (y1 + y2) / 2];
    return [{ x: nx, y: ny, text: pr.net || sym.power, size: 10, bold: true, power: true, anchor: sym.netText ? 'middle' : 'start' }];
  }
  const out = [];
  const lines = [p.ref, pr.value].filter((v) => v != null && v !== '');
  const pos = pr.labelPos;
  if (pos === 'below') lines.forEach((t, i) => out.push({ x: (x1 + x2) / 2, y: y2 + 9 + i * 12, text: t, size: i ? 9 : 10, bold: !i, muted: !!i, anchor: 'middle' }));
  else {
    const top = (y1 + y2) / 2 - (lines.length - 1) * 6;
    lines.forEach((t, i) => out.push({ x: pos === 'left' ? x1 - 6 : x2 + 6, y: top + i * 12, text: t, size: i ? 9 : 10, bold: !i, muted: !!i, anchor: pos === 'left' ? 'end' : 'start' }));
  }
  const block = [[pr.circuit, pr.phase].filter(Boolean).join(' · '), [pr.cable, pr.length ? `${pr.length}${/^[\d.]+$/.test(pr.length) ? 'm' : ''}` : ''].filter(Boolean).join(' ')].filter(Boolean);
  if (block.length) {
    const pins = pinsOf(p), q = pins.reduce((a, b) => (b.y >= a.y ? b : a), pins[0]);
    const y0 = (pos === 'below' ? y2 + 9 + lines.length * 12 : q.y + 10);
    block.forEach((t, i) => out.push({ x: q.x + 5, y: y0 + i * 10, text: t, size: 8, muted: true, anchor: 'start' }));
  }
  return out;
}

// One part: symbol shapes (rotated), upright inner text, then ref/value beside it.
export function partSvg(p, c = LIGHT, { pins: showPins = false, connected } = {}) {
  const sym = symbolOf(p);
  const tf = `translate(${p.x} ${p.y}) rotate(${p.rot || 0})${p.mirror ? ' scale(-1 1)' : ''}`;
  let g = `<g transform="${tf}" fill="none" stroke="${c.ink}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">`;
  for (const s of sym.shapes) {
    if (s.d) g += `<path d="${s.d}"${s.fill ? ` fill="${c.ink}"` : ''}${s.dash ? ' stroke-dasharray="3 3"' : ''}/>`;
    else if (s.c) g += `<circle cx="${s.c[0]}" cy="${s.c[1]}" r="${s.c[2]}"/>`;
  }
  g += '</g>';
  for (const s of sym.shapes) if (s.t) {
    const [x, y] = xform(p, [s.t[0], s.t[1]]);
    const t = String(s.t[2]).replace(/\{(\w+)\}/g, (_, k) => p.props?.[k] ?? '');
    let anchor = s.anchor || 'middle';
    if (anchor !== 'middle' && (p.mirror ? !(p.rot % 180) : false)) anchor = anchor === 'start' ? 'end' : 'start';
    if (anchor !== 'middle' && p.rot % 180) anchor = 'middle';
    if (anchor !== 'middle' && p.rot === 180) anchor = anchor === 'start' ? 'end' : 'start';
    g += T(x, y, t, s.t[3] || 10, `fill="${c.ink}" text-anchor="${anchor}" dominant-baseline="central"`);
  }
  for (const t of partTexts(p)) g += T(t.x, t.y, t.text, t.size, `${t.bold ? 'font-weight="600" ' : ''}fill="${t.power ? c.ink : t.muted ? c.muted : c.text}" text-anchor="${t.anchor}" dominant-baseline="central"`);
  if (showPins) for (const q of pinsOf(p)) if (!connected?.has(key(q.x, q.y))) g += `<circle cx="${q.x}" cy="${q.y}" r="2" fill="none" stroke="${c.pin}" stroke-width="1"/>`;
  return g;
}

// A wire; a labelled one (busbars: "L1 L2 L3 N 400V") carries its label past the right/bottom end.
export function wireSvg(w, c = LIGHT) {
  let g = `<polyline points="${w.pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${w.kind === 'bus' ? c.bus : c.wire}" stroke-width="${w.kind === 'bus' ? 5 : 1.6}" stroke-linecap="square" stroke-linejoin="miter"/>`;
  if (w.label) { const [x, y, at] = wireLabelAt(w); g += T(x, y, w.label, 10, `font-weight="600" fill="${c.text}" text-anchor="${at}" dominant-baseline="central"`); }
  return g;
}
// Where a wire's label goes: after the end that lies furthest right (or down, for a vertical end segment).
function wireLabelAt(w) {
  const a = w.pts[0], b = w.pts.at(-1), [e, n] = b[0] > a[0] || (b[0] === a[0] && b[1] >= a[1]) ? [b, w.pts.at(-2)] : [a, w.pts[1]];
  return e[1] === n[1] ? [e[0] + (e[0] >= n[0] ? 8 : -8), e[1], e[0] >= n[0] ? 'start' : 'end'] : [e[0], e[1] + (e[1] >= n[1] ? 10 : -10), 'middle'];
}

// Labels: net labels, free text, board rectangles (kind "rect") and tables (kind "table"). sheet: for auto tables.
export function labelSvg(l, c = LIGHT, sheet) {
  if (l.kind === 'text') return T(l.x, l.y, l.text, 11, `fill="${c.text}" dominant-baseline="central"`);
  if (l.kind === 'rect') return `<g><rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" fill="none" stroke="${c.ink}" stroke-width="1.4"${l.dash !== false ? ' stroke-dasharray="10 5"' : ''}/>${l.text ? T(l.x + 8, l.y + 13, l.text, 11, `font-weight="600" fill="${c.text}" dominant-baseline="central"`) : ''}</g>`;
  if (l.kind === 'table') return tableSvg(l, c, sheet);
  const w = Math.max(20, l.text.length * 6.6 + 10);
  return `<g><path d="M${l.x} ${l.y}l6 -8h${w}v16h${-w}z" fill="${c.bg}" stroke="${c.label}" stroke-width="1.2"/>${T(l.x + 10, l.y + 0.5, l.text, 10, `font-weight="600" fill="${c.label}" dominant-baseline="central"`)}</g>`;
}
// A table's cells: auto "circuits" builds them from the sheet's circuit props.
function tableCells(l, sheet) {
  if (l.auto === 'circuits') { const rows = sheet ? circuits([sheet]) : []; const cols = CIRCUIT_COLS.filter(([k]) => rows.some((r) => r[k])); return { cols: cols.map((x) => x[1]), rows: rows.map((r) => cols.map(([k]) => r[k])) }; }
  return { cols: l.cols || [], rows: l.rows || [] };
}
const ROW = 16;
function tableLayout(l, sheet) {
  const { cols, rows } = tableCells(l, sheet);
  const n = Math.max(cols.length, ...rows.map((r) => r.length), 1);
  const ws = Array.from({ length: n }, (_, i) => Math.max(30, ...[cols[i] ?? '', ...rows.map((r) => r[i] ?? '')].map((v) => units(v).length * 5.8 + 10)));
  const head = (l.text ? ROW : 0) + (cols.length ? ROW : 0);
  return { cols, rows, ws, W: ws.reduce((a, b) => a + b, 0), H: head + Math.max(1, rows.length) * ROW, head };
}
function tableSvg(l, c, sheet) {
  const { cols, rows, ws, W, H, head } = tableLayout(l, sheet);
  const xs = ws.reduce((a, w) => [...a, a.at(-1) + w], [l.x]);
  let g = `<g><rect x="${l.x}" y="${l.y}" width="${W}" height="${H}" fill="${c.bg}" stroke="${c.frame}"/>`;
  let y = l.y;
  if (l.text) { g += T(l.x + 5, y + ROW / 2, l.text, 10, `font-weight="600" fill="${c.text}" dominant-baseline="central"`); y += ROW; g += `<path d="M${l.x} ${y}H${l.x + W}" stroke="${c.frame}"/>`; }
  const row = (cells, yy, bold) => cells.map((v, i) => T(xs[i] + 5, yy + ROW / 2, v ?? '', 9, `${bold ? 'font-weight="600" ' : ''}fill="${bold ? c.muted : c.text}" dominant-baseline="central"`)).join('');
  if (cols.length) { g += row(cols, y, true); y += ROW; }
  rows.forEach((r, i) => { g += `<path d="M${l.x} ${y + i * ROW}H${l.x + W}" stroke="${c.frame}" stroke-width="${i ? 0.5 : 1}"/>` + row(r, y + i * ROW); });
  if (!rows.length) g += T(l.x + 5, y + ROW / 2, l.auto ? 'no circuits yet: set circuit / cable / phase on the breakers' : '(empty)', 9, `fill="${c.muted}" dominant-baseline="central"`);
  g += xs.slice(1, -1).map((x) => `<path d="M${x} ${l.y + (l.text ? ROW : 0)}V${l.y + H}" stroke="${c.frame}" stroke-width="0.5"/>`).join('');
  return g + '</g>';
}
// Box of a label, for selection.
export function labelBox(l, sheet) {
  if (l.kind === 'net') return [l.x, l.y - 8, l.x + Math.max(20, l.text.length * 6.6 + 10) + 6, l.y + 8];
  if (l.kind === 'rect') return [l.x, l.y, l.x + l.w, l.y + l.h];
  if (l.kind === 'table') { const t = tableLayout(l, sheet); return [l.x, l.y, l.x + t.W, l.y + t.H]; }
  return [l.x, l.y - 7, l.x + l.text.length * 6.2, l.y + 7];
}

// Frame with zone numbers/letters and a title block in the bottom right.
export function frameSvg(sheet, c = LIGHT, project = {}) {
  const [W, H] = SIZES[sheet.size] || SIZES.A3, m = 20;
  let g = `<rect x="0" y="0" width="${W}" height="${H}" fill="${c.bg}"/><g fill="none" stroke="${c.frame}" stroke-width="1"><rect x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 2 * m}"/><rect x="${m - 12}" y="${m - 12}" width="${W - 2 * m + 24}" height="${H - 2 * m + 24}"/>`;
  for (let x = ZONE; x < W - m; x += ZONE) g += `<path d="M${x} ${m - 12}V${m}M${x} ${H - m}V${H - m + 12}"/>`;
  for (let y = ZONE; y < H - m; y += ZONE) g += `<path d="M${m - 12} ${y}H${m}M${W - m} ${y}H${W - m + 12}"/>`;
  g += '</g>';
  for (let i = 0; i * ZONE < W; i++) { const x = Math.min(i * ZONE + ZONE / 2, W - m - 6); g += `<text x="${x}" y="${m - 5}" ${FONT} font-size="9" fill="${c.muted}" text-anchor="middle">${i + 1}</text><text x="${x}" y="${H - m + 9}" ${FONT} font-size="9" fill="${c.muted}" text-anchor="middle">${i + 1}</text>`; }
  for (let i = 0; i * ZONE < H; i++) { const y = Math.min(i * ZONE + ZONE / 2, H - m - 6); const L = String.fromCharCode(65 + i); g += `<text x="${m - 6}" y="${y}" ${FONT} font-size="9" fill="${c.muted}" text-anchor="middle" dominant-baseline="central">${L}</text><text x="${W - m + 6}" y="${y}" ${FONT} font-size="9" fill="${c.muted}" text-anchor="middle" dominant-baseline="central">${L}</text>`; }
  const t = { ...project, ...sheet.title };
  const bw = 360, bh = 80, bx = W - m - bw, by = H - m - bh;
  const cell = (x, y, w, h, label, val, big) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c.bg}" stroke="${c.frame}"/><text x="${x + 4}" y="${y + 9}" ${FONT} font-size="7" fill="${c.muted}">${label}</text>` + T(x + 4, y + h - 6, val ?? '', big ? 13 : 10, `${big ? 'font-weight="600" ' : ''}fill="${c.text}"`);
  if (sheet.refPrefix) g += cell(bx, by, bw - 90, 40, 'TITLE', t.title || sheet.name, true) + cell(bx + bw - 90, by, 90, 40, 'LOCATION', sheet.refPrefix, true);
  else g += cell(bx, by, bw, 40, 'TITLE', t.title || sheet.name, true);
  g += cell(bx, by + 40, 120, 40, 'DRAWING NO.', t.drawingNo) + cell(bx + 120, by + 40, 60, 40, 'REV', t.rev) + cell(bx + 180, by + 40, 90, 40, 'DRAWN', t.author) + cell(bx + 270, by + 40, 90, 40, 'SHEET', `${sheet.id}${t.of ? ' / ' + t.of : ''}`);
  return g;
}

// Cross-reference text under coils ("13-14 → 2.C") and beside contacts ("→ 1.B").
export function crossRefSvg(sheet, sheets, c = LIGHT) {
  const xr = crossRefs(sheets);
  let g = '';
  for (const p of sheet.parts) {
    const sym = symbolOf(p), r = xr[fullRef(sheet, p.ref)];
    if (!r || sym.power) continue;
    const [, , x2, y2] = bboxOf(p);
    if (sym.contact && r.device) g += `<text x="${x2 + 6}" y="${p.y + 18}" ${FONT} font-size="8" fill="${c.muted}">→ ${esc(r.device.loc)}</text>`;
    else if (!sym.contact && r.contacts.length) r.contacts.forEach((k, i) => { g += `<text x="${x2 + 6}" y="${y2 + 10 + i * 10}" ${FONT} font-size="8" fill="${c.muted}">${esc(`${k.kind} ${k.pins} ${k.loc}`)}</text>`; });
  }
  return g;
}

// A whole sheet as a standalone SVG.
export function sheetSvg(sheet, sheets = [sheet], c = LIGHT, project = {}) {
  const [W, H] = SIZES[sheet.size] || SIZES.A3;
  const { junctions } = connectivity(sheet);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` + frameSvg(sheet, c, project)
    + sheet.wires.map((w) => wireSvg(w, c)).join('') + sheet.parts.map((p) => partSvg(p, c)).join('') + sheet.labels.map((l) => labelSvg(l, c, sheet)).join('')
    + junctions.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.2" fill="${c.junction}"/>`).join('') + crossRefSvg(sheet, sheets, c) + '</svg>';
}

// Small preview of a symbol, for the palette.
export function symbolPreview(symKey, c = LIGHT) {
  const p = { id: 'x', ref: '', sym: symKey, x: 0, y: 0, rot: 0, props: { ...(S[symKey].props || {}) } };
  const [x1, y1, x2, y2] = bboxOf(p);
  const pad = 4, w = x2 - x1 + 2 * pad, h = y2 - y1 + 2 * pad;
  const inner = partSvg({ ...p, ref: '' }, { ...c, text: 'transparent', muted: 'transparent' }).replace(/<text[^>]*font-weight="600"[^>]*>[^<]*<\/text>$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x1 - pad} ${y1 - pad} ${w} ${h}">${inner}</svg>`;
}
