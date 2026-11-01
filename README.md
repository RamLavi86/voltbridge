# voltbridge

A local web app for drawing electrical schematics with Claude: a chat on the left, a schematic editor on the right (IEC 60617-style symbols, sheets with zone frames and title blocks, wires, busbars, net labels). Same idea as drawbridge, but the canvas is its own SVG editor with an electrical model behind it, so Claude and the editor both work on real parts, pins and nets, not shapes.

Claude runs through the Claude Agent SDK with your `claude` CLI login, with full file access to the project's working folder and **no permission prompts**. That is why the server listens on localhost only by default.

## Run

Needs Node 20.19+ and a logged-in `claude` CLI.

```
npm install
npm start              # builds the UI when web/ changed, then http://127.0.0.1:8430
PORT=8440 npm start
HOST=0.0.0.0 npm start # prints http://<host>:8430/?token=... ; open it once, it sets a cookie
npm test               # model, tools, sessions; writes test-out/sheet*.png
```

| var | default | |
|---|---|---|
| `PORT` | `8430` | |
| `HOST` | `127.0.0.1` | Off loopback a token is required (`~/.voltbridge/token` or `VOLTBRIDGE_TOKEN`). |
| `VOLTBRIDGE_CWD` | `~/ioe`, else home | Working folder for new projects. |
| `VOLTBRIDGE_SESSIONS` | `~/.voltbridge/sessions` | Where projects are stored. |

**Gemini instead of Claude.** Put `GEMINI_API_KEY` (from https://aistudio.google.com/apikey) in a git-ignored `.env` (see `.env.example`) and start with `VOLTBRIDGE_PROVIDER=gemini`. The model then only has the voltbridge tools, with no shell or file access. A hosted server (`HOST` not loopback) uses Gemini automatically.

## Editor

- **Palette** (left of the canvas): symbols by category, with search. Click one, then click on the sheet to place it (repeatedly; R rotates the ghost, Esc or right-click stops).
- **Tools**: Select (V), Wire (W), Busbar (B), Net label (N), Text (T). Wires are orthogonal: click to start and bend, click a pin or a wire to finish, double-click or right-click to end, `/` flips the corner. A wire end on another wire joins it (junction dot).
- **Edit**: drag to move (wires on the pins follow), R / Shift+R rotate, X mirror, Del delete, arrows nudge, Ctrl+D duplicate, Ctrl+C / X / V (also across sheets), Ctrl+A, Ctrl+Z / Ctrl+Y. Box-select left-to-right picks what is inside, right-to-left what it touches.
- **View**: wheel zooms, middle/right-drag or Space-drag pans, F fits the sheet.
- **Inspector** (right): designator, symbol, value, part number, maker, description and custom properties; pins with their nets; coil/contact cross references. With nothing selected: sheet name and size, title block, project defaults, checks (unconnected pins, duplicate designators, contacts without a coil) and the net list.
- **Sheets**: tabs (+ adds, double-click renames, drag reorders). Net labels and power symbols with the same name join nets across sheets.
- **Export**: sheet SVG/PNG, print/PDF of all sheets, BOM CSV, netlist CSV, project JSON, or write everything into the output folder (`<cwd>/schematics`).

**Distribution boards.** Multi-line 4-pole devices (`rcd_4p`, `rcbo`, `breaker_4p`, `switch_disconnector_4p`); on a single line, set `poles` ("3", "4", "3P+N") on breaker/fuse/disconnector/SPD/RCD to draw the IEC pole strokes (the RCD then becomes a 1-in/1-out symbol). Load symbols: socket (n-way), light, water heater, cooker, A/C, EV charger; N and PE bars; PV array, battery storage and hybrid inverter for single-line PV. Props `circuit`, `cable`, `length`, `phase`, `power`, `load` on an outgoing breaker draw a small block beside its line, feed the circuit table (Circuit table tool, or Claude's `table` op), the circuit schedule CSV, cable totals in the BOM, and a phase-imbalance check. Board frame tool (E) draws a dashed enclosure with its name. A sheet's designation prefix (e.g. `=MDB2`) numbers its parts from 1 again and shows `=MDB2-Q1` in BOM/netlist. Hebrew/Arabic text renders the same in the browser and in PNGs; `mm2` shows as mm².

Coils and their contacts share a designator (K1 coil, K1 13-14 contact). Under each coil the drawing lists its contacts with their zones; each contact shows where its coil is.

## Claude's tools

`list_sheets`, `list_symbols`, `get_sheet` (parts with absolute pins and nets, wires, labels, nets, issues), `edit_sheet` (add / connect / wire / label / rect / table / array / update / delete / sheet ops in one batch), `new_sheet`, `delete_sheet`, `set_project`, `snapshot` (PNG via resvg, no browser needed), `get_netlist`, `get_bom`, `export`. The model lives on the server, so Claude can draw with no browser open; open windows update live, and Ctrl+Z undoes Claude's edits too.

## Files

`~/.voltbridge/sessions/<name>/`: `session.json` (Claude session id, cwd, output folder, sheet order, project title fields), `sheet-<n>.json`, `images/` (pasted chat images).

Developer guide (architecture, protocol, sync, security, how to extend): [docs/DEVELOPING.md](docs/DEVELOPING.md).

`web/schematic.js` is the shared model (symbols, geometry, connectivity, ops, BOM/netlist, SVG rendering), used by both the server and the browser. `lib.js` holds storage and Claude's tools, `server.js` the HTTP/WebSocket server and the Claude loop, `web/editor.jsx` the canvas, `web/panels.jsx` palette/toolbar/inspector/export.

## Not yet

Terminal strips, wire numbers, a PLC I/O symbol generator, a thermal overload relay, DXF/DWG export, symbol editor, 3D/panel layout.
