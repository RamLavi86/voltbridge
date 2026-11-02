# voltbridge — developer guide

For someone taking over the code. User-facing features and run options are in [../README.md](../README.md); this file covers how it is built, where things live, and what to watch out for.

## What it is

A single-user local web app: a Claude chat on the left and an electrical schematic editor (custom SVG, IEC 60617-style symbols) on the right. Claude draws through MCP tools that edit the same server-side model the editor shows. It is the sibling of `~/ioe/drawbridge` (same chat/session concept, Excalidraw canvas); voltbridge has its own editor and an electrical model (parts, pins, nets), so a schematic means something electrically and isn't just shapes.

Stack: Node 20.19+ (ESM, no TypeScript), `ws`, `@anthropic-ai/claude-agent-sdk`, `@resvg/resvg-js` (PNG), React 19 + Vite 7 (UI), `zod` (tool schemas), `marked` + `dompurify` (chat markdown). No database, no framework on the server.

## Layout

| file | lines | role |
|---|---|---|
| `web/schematic.js` | ~860 | **The model.** Symbol library, geometry, connectivity/nets, edit ops, designators, checks, BOM/netlist/circuits, SVG rendering, bidi text. Pure JS, no DOM: imported by both the server and the browser. Most work happens here. |
| `lib.js` | ~200 | Session storage on disk, sheet CRUD, exports, and Claude's MCP tools (`makeTools`) with the ops reference text (`OPS_DOC`). No HTTP, so `test.js` drives it directly. |
| `ai.js` | ~170 | The API chat loop: OpenRouter adapter (SSE streaming), tool declarations from the zod shapes, `runAgent`. |
| `auth.js` | ~80 | Google sign-in through Supabase: token check, signed session cookie, monthly caps and usage log. |
| `server.js` | ~330 | HTTP (static `dist/`, pasted images), sign-in routes and per-user sessions, WebSocket protocol, the Claude loop (`chat()`), the appended system prompt (`PROMPT`), chat history replay. |
| `web/main.jsx` | ~400 | App shell: WebSocket client, per-sheet undo/redo and sync, sheet tabs, session picker, chat and composer. |
| `web/editor.jsx` | ~300 | The canvas: pan/zoom, tools (select, wire, bus, net, text, rect, table, place symbol), drag/rotate/mirror, box select, clipboard. |
| `web/panels.jsx` | ~250 | Palette, toolbar, inspector (part, wire, label, sheet properties, checks, net list), export menu, status bar. |
| `web/ui.jsx`, `web/style.css`, `web/index.html` | | Icons, localStorage wrapper, styles (light/dark via `data-theme`). |
| `test.js` | ~200 | `node test.js`: model + tools + sessions, writes `test-out/*.png` to look at. |

`dist/`, `node_modules/`, `test-out/` are git-ignored. `server.js` rebuilds `dist/` itself on start when anything in `web/` is newer, so there is no separate build step.

## Data model (`web/schematic.js`, top of file)

```
sheet: { id, name, size: A4|A3|A2|A1, title: {...}, refPrefix?, parts, wires, labels, rev, nextId }
part:  { id, ref, sym, x, y, rot: 0|90|180|270, mirror, props }
wire:  { id, pts: [[x,y],...], kind?: 'bus', label? }           orthogonal polyline
label: { id, kind: 'net'|'text'|'rect'|'table', text, x, y, ... } rect: w,h,dash; table: auto|cols,rows
```

- Coordinates are px on a 10px grid (`GRID`, `snap`). A3 = 1680×1190. Zones every 200px (`ZONE`) give "3.B" cross-references.
- **Connectivity is computed, never stored.** `connectivity(sheet)` joins points that touch (wire vertices, a wire end on another wire's segment, pins on wire vertices) into nets. Net labels and power symbols name nets; the same name joins nets across sheets (`netlist`).
- **Several parts can share a ref**: a coil K1 and its contacts K1 13-14, 21-22. `findPin("K1:13")` picks the right one by pin name. `crossRefs` links them by zone.
- **Designators** are scoped by `sheet.refPrefix` (e.g. `=MDB2`): `nextRef`, `peers`, `fullRef` ("=MDB2-Q1"). BOM, netlist and cross-refs use the full ref.
- `rev` increases on every accepted change; the sync protocol below relies on it.

### Symbols

`def(key, {name, cat, prefix, pins, box, shapes, value?, ...})`. Local coordinates, anchor at origin; two-terminal parts stand vertically with pin 1 on top. Shapes: `{d}` SVG path, `{c:[cx,cy,r]}` circle, `{t:[x,y,text,size]}` upright text; `fill`/`dash` flags. Pins must land on the grid at every rotation, so use multiples of 10.

Special flags handled in `symbolOf(part)`:
- `poleMark: true`: `props.poles` ("3", "3P+N") adds IEC oblique pole strokes (`poleTicks`).
- `sld: {...}`: an alternate single-line form used when `props.poles` is set (the RCD).
- `bar`: N/PE bars sized by `props.ways` (`barSymbol`).
- `dynamic`: the generic block, with pins from `props.left/right/top/bottom`.
- `power: 'NET'`: a power symbol, names the net it touches.
- `contact: true`: a contact that takes its coil's ref.

Adding a symbol = one `def(...)` line. It then appears in the palette, in `list_symbols`, and in the BOM. Add a test or at least look at a `snapshot`.

**The symbols are hand-drawn approximations of IEC 60617, not checked against the standard.** Several (water heater, cooker, A/C, EV charger, hybrid inverter) are my own shapes. If they are used for real drawings, review them against the standard or a vendor library.

### Edit ops

`applyOps(sheet, ops, sheets)` is the single write path for Claude (and for `addPart`/`addWire` helpers). Ops: `add`, `update`, `delete`, `wire`, `connect` (auto-routes with `route()`), `label`, `rect`, `table`, `array` (repeat sub-ops; `{i}` and `$j` substitution in `shiftOp`), `sheet`. It returns `{added, errors, warnings}`; a bad op is reported and the others still apply. The ops documentation Claude sees is `OPS_DOC` in `lib.js`. **Keep it in step when you change an op.**

The editor does *not* send ops. It edits a cloned sheet locally (`moveParts`, `turnParts`, `duplicate`, `removeItems`, and others) and sends the whole sheet.

### Rendering

`sheetSvg` = `frameSvg` (zones, title block) + wires + parts (`partSvg`, `partTexts`) + labels (`labelSvg`, tables) + `crossRefSvg`. The same markup is used in the browser, for SVG/PNG export, and for Claude's `snapshot`. PNGs come from resvg with system fonts (DejaVu Sans).

**Hebrew/Arabic text:** resvg does no proper bidi, so `visual()` runs a reduced Unicode bidi algorithm (runs plus bracket mirroring) and `T()` emits the visual string wrapped in LRO…PDF with `unicode-bidi="bidi-override"`. Browser and PNG then match. Don't "simplify" this back to plain text: Hebrew comes out reversed in PNGs.

### Checks

`check(sheet, sheets)` returns the issues shown in the inspector and returned to Claude after every `edit_sheet`: unconnected pins, diagonal wires, duplicate refs, contacts without a coil, text overlaps (`textBoxes`), phase imbalance above 20% (`phaseLoads`).

## Server

### Sessions on disk

`~/.voltbridge/sessions/<name>/session.json` (claudeSessionId, cwd, outDir, sheet order, project title fields), `sheet-<id>.json`, `images/`. Loaded into memory on first `open` (`attach`) and kept in the `live` map. User edits are saved 400ms after the last change (`touch`), Claude's edits right away (`editSheet`). Overrides: `VOLTBRIDGE_SESSIONS`, `VOLTBRIDGE_CWD`.

### WebSocket protocol (`/ws`)

Client → server: `list`, `open {name, cwd?}`, `renameSession`, `deleteSession`, `chat {text, images, sheet, selection}`, `stop`, `sheet {doc, baseRev}`, `newSheet`, `deleteSheet`, `moveSheet`, `project {fields}`, `export {format, sheet?}`, `outDir`.

Server → client: `hello`, `sessions`, `session` (full state plus chat history), `sheets`, `sheet {doc, by?, conflict?}`, `ack {id, rev}`, `user`, `delta` (streamed text), `tool`/`tool_done`, `error`, `done`, `exported`, `renamed`, `deleted`, `outDir`.

### Sync and undo (optimistic, last-writer-loses)

- The editor commits locally, then sends the whole sheet 250ms later with `baseRev`. `lib.putSheet` accepts it only if `baseRev === rev`, bumps `rev` and broadcasts to the other windows. Otherwise it replies with the server copy plus `conflict` and the editor shows a toast.
- One request per sheet is in flight at a time (`sync` state in `main.jsx`: base, inflight, dirty).
- Claude's edits arrive as `sheet {by:'claude'}`. The editor pushes its current doc onto the undo stack first, so **Ctrl+Z also undoes Claude's edits**.
- Undo history is per sheet, in browser memory only (200 steps) and is lost on reload.

This is fine for one user with a couple of windows. It is not multi-user collaboration; see "Taking it further".

### The Claude loop (`chat()` in server.js)

- `query()` from the Agent SDK runs the Claude Code engine with the machine's `claude` CLI login, or `ANTHROPIC_API_KEY` if set. No model is pinned, so the Claude Code default applies.
- Options:
  - `resume: claudeSessionId` keeps one Claude conversation per voltbridge session.
  - `systemPrompt: {preset:'claude_code', append: PROMPT}`.
  - `mcpServers: {voltbridge: makeMcp(...)}`: in-process tools that edit the live session.
  - `includePartialMessages` drives streaming.
  - **`permissionMode: 'bypassPermissions'`**.
- Each user message gets `[voltbridge] …` prefix lines: the output folder, the sheet the user is looking at plus its selection, and the paths of pasted images. `history()` strips them when it replays the chat from the SDK's transcript.
- Pasted images go to Claude as image blocks and are also saved under `images/`.
- Tool events stream to the chat as `tool`/`tool_done`. Subagent messages (`parent_tool_use_id`) are skipped.

### The API loop (OpenRouter, `chatApi()` in server.js, `ai.js`)

`VOLTBRIDGE_PROVIDER=openrouter` (the default off loopback) answers the chat through OpenRouter instead of the Claude Code engine. The model gets only the voltbridge tools: no shell, no files, so it is safe to host. OpenRouter is one key for many models; the model is chosen by `OPENROUTER_MODEL`.

- `lib.toolDefs()` is the single list of tools (`{name, description, shape (zod), handler}`); `makeTools` wraps it for the Claude SDK, `ai.apiTools` turns it into function declarations.
- **Schema quirk:** some providers reject objects without `properties`, so free-form args (`edit_sheet`'s `ops`, an array of free-form objects) are declared as strings holding JSON and parsed before the handler runs (`clean()` in ai.js). If you add a tool with a free-form argument, it just works; if the model sends bad JSON the handler error goes back to it.
- `runAgent` is the loop: one `provider.step()` per model call (streamed over SSE, text goes out as `delta`), run the tool calls, append the results, repeat up to 25 steps. A new provider is an object with `step()` like `openaiProvider`; `openrouterProvider` is that over OpenAI-style `/chat/completions`, and any compatible server can reuse it via `baseUrl`.
- The transcript is ours: `s.chat` in `chat.json` per session (user text plus the `[voltbridge]` context lines, assistant text and calls, tool results). Streamed `reasoning_details` are merged and replayed on the assistant message (`raw`), as some models need. Only the last 60 messages are sent.
- `snapshot` returns a PNG. A `tool` message holds text only, so the image follows in a `user` message, for the latest tool turn only, and is not saved. If the API answers 400 to that, the provider drops images for the rest of the process and carries on.
- Settings: `OPENROUTER_API_KEY` (header, never in a URL), `OPENROUTER_MODEL` (required, no default: copy an id from openrouter.ai/models?supported_parameters=tools), `OPENROUTER_FALLBACKS` (comma list, sent as `models`), `OPENROUTER_DATA_COLLECTION` (`deny` by default: only providers that don't store prompts or train on them), `OPENROUTER_BASE_URL` (tests). Requests carry `provider.require_parameters` so a model is only routed to endpoints that support tools. A git-ignored `.env` is loaded at start; see `.env.example`.
- Each chat logs tokens and, when OpenRouter reports it, the cost in dollars.
- `npm test` runs the loop against a scripted fake server (streamed and split SSE events, tool-call assembly, reasoning replay, image fallback, rejected key, no credits). **The tests never call the real API.** Try "a DOL motor starter" with a real key after any change here.
- Prompt: `API_PROMPT` = `PROMPT` plus a few lines about having no shell, plus the whole symbol library (`lib.symbolText()`, compact text), so the model needs no `list_symbols` step. Each user message starts with `lib.sheetsSummary()`, which replaces `list_sheets`.
- **Token economy** (every step is a request that resends everything, and you pay for the tokens each time):
  - Fixed cost per request is about 4,000 tokens: tool declarations ~1,900 (mostly `OPS_DOC`), prompt plus library ~2,200. That is most of a typical run, so it is the next thing to shrink, but only with a side-by-side quality check on the live model.
  - `chatMessages()` in ai.js sends only the newest copy of a repeated `get_sheet`/`get_netlist`/`get_bom`/`list_sheets` (same arguments), only the newest pasted image, and at most `BUDGET` characters of history, dropping whole oldest turns first (`view()` and `fit()`). The stored transcript is untouched.
  - `get_sheet` omits `net` on unconnected pins; `list_symbols` is text without bounding boxes (placed parts still carry `bbox`).
- **Model comparison (seen 2026-11-02, one run per case, real OpenRouter calls):** the same three prompts (DOL starter, house board, recreate from an image) on `deepseek/deepseek-v4.1-flash` ($0.04 in / $0.50 out per million tokens), `anthropic/claude-haiku-5.5` ($0.10 / $0.50) and `qwen/qwen3.8-flash`. DeepSeek and Haiku both finished in 35-73 s at about 0.7-2 cents per drawing, so roughly $1-2 per 100 drawings. DeepSeek's board was clean; Haiku's board left 13 dangling pins but its starter and photo were the tidiest. Qwen took 2-5 times as long (one run hit a 300 s limit). Repeat before relying on any of this: model ids and prices change.

**What Claude is told** is all in two places: `PROMPT` (server.js, drawing conventions) and the tool descriptions plus `OPS_DOC` (lib.js, the API). When Claude draws badly, fix those first. Then improve what `check()` reports, because Claude reads the issues and fixes them.

### Security model

- Binds `127.0.0.1` by default.
- With `HOST=0.0.0.0` a random token is created in `~/.voltbridge/token` (or taken from `VOLTBRIDGE_TOKEN`). Opening `/?token=…` once sets an HttpOnly cookie, which is checked on HTTP and on the WebSocket upgrade.
- Static serving and image paths are confined (`inside`, `validName`).
- **Claude has Bash and file access as the server's user, with no prompts.** Anyone holding the token effectively has a shell on the machine. Treat the token like an SSH key.

## Running it

```
npm install
npm start                       # http://127.0.0.1:8430
HOST=0.0.0.0 PORT=8420 npm start
npm test                        # 9 checks; look at test-out/*.png
```

On Ram's VM it was run under a restart loop, `~/.voltbridge/run.sh` (HOST=0.0.0.0, PORT=8420, the port drawbridge normally uses; log `~/.voltbridge/server.log`). To stop it, kill the `run.sh` loop first, then the `node server.js` pid. It is **currently stopped**, and drawbridge owns 8420 again.

## Testing

- `test.js` uses a tiny `ok(name, fn)` runner, a temp sessions dir, and calls the MCP tool handlers directly (`makeTools(...)[i].handler`). It covers ops, routing, nets, designators/prefixes, BOM/netlist, the distribution-board example, overlap checks, and a session round-trip. It renders PNGs; *look at them* after model or rendering changes.
- There are no UI tests in the repo. During development the UI was checked with puppeteer-core driving a headless Firefox (`~/opt/firefox`) from a scratch script. Snap Firefox is broken on this VM.
- To try Claude end-to-end, start the server, open the page and ask it to draw something like "a DOL motor starter with control circuit". Then check the snapshot.

## Known gaps

- Not yet: terminal strips, wire numbers, PLC I/O generator, thermal overload relay symbol, DXF/DWG export, a symbol editor, panel layout/3D.
- Manual (non-auto) tables can be created by Claude but not edited in the inspector.
- Symbols are unverified against IEC 60617 (see above).
- Undo is per window and lost on reload. The sync conflict policy replaces the local edit.
- Without Supabase configured, a single shared token and no user accounts (see "Hosted deployment").
- JSON files rewritten whole on save. That's fine at this size.

## Taking it further (hosting for other people / other AI assistants)

The current design is only safe for one person on their own machine. To host it:

1. ~~Drop the Claude Code engine for the chat.~~ Done via OpenRouter (see "The API loop"). A direct Claude or other adapter would be one more provider object in `ai.js`.
2. **Users and storage:** SSO login, per-user/team projects in a database instead of `~/.voltbridge`, per-user rate/usage limits. HTTPS, with IT/security approval.
3. **Collaboration:** replace whole-sheet last-writer-loses with op-based sync (the `applyOps` ops are a good starting vocabulary), or a CRDT.
4. **Other AI assistants:** expose `makeTools` as a standalone remote MCP server (streamable HTTP + OAuth). The model is server-side already, so Claude Desktop, Claude Code or other agents could draw without the web chat.
5. If Claude ever needs to run code (calculations, cable sizing), give each user a sandbox, such as a hosted agent with a managed sandbox. Never use Bash on the host.

## Hosted deployment

- `Dockerfile` (Node 22 + DejaVu fonts, builds `dist/`), `render.yaml` (Render blueprint, auto-deploy once CI passes), `.github/workflows/ci.yml` (`npm test` + UI build on pushes and PRs).
- Off loopback (`HOST=0.0.0.0`, set by the Dockerfile) the server uses the OpenRouter provider (the Claude Code engine stays off: `VOLTBRIDGE_CHAT=1` with `VOLTBRIDGE_PROVIDER=claude` overrides, only for a trusted private machine; `CHAT` in server.js), ignores a client-supplied working folder and refuses the `outDir` message. Public without login: `/healthz`, `/privacy`, `/terms` (`pages/`, linked from Google's consent screen), and the sign-in routes.
- **Sign-in (auth.js)** is on when `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (Supabase's secret key, `sb_secret_...`, sent in the `apikey` header only; the legacy `service_role` JWT also works) are set; otherwise a hosted server falls back to the shared `VOLTBRIDGE_TOKEN` (one user, everything shared). Flow: `/` shows `pages/landing.html`; `/auth/google` redirects to Supabase's Google authorize URL; Supabase returns to `/auth/callback` (`pages/callback.html`) with the tokens in the URL fragment; the page POSTs the access token to `/auth/session`; `auth.login()` verifies it: an ES256/RS256 token is checked locally against the project's public keys (`/auth/v1/.well-known/jwks.json`, no API key; issuer, audience, expiry, verified Google email), an HS256 one with Supabase (`/auth/v1/user`) and the server sets its own cookie `vb` (HMAC-signed id + email, HttpOnly, SameSite=Lax, 7 days; the key is derived from the service key). The browser never holds the service key. WebSocket upgrades need the cookie and a same-host `Origin`.
- **Separation:** each user gets `VOLTBRIDGE_SESSIONS/u_<id>/` (`user.root`), passed as `root` to the `lib.js` session functions; live sessions are keyed `<id>/<name>`; session lists go only to that user's sockets; `/img/…` resolves inside the caller's folder. Exports go to `u_<id>/schematics`.
- **Caps (dollars per UTC month):** `USER_MONTHLY_CAP_USD` (default 0.50) and `GLOBAL_MONTHLY_CAP_USD` (default 10). Before each API chat `auth.limits()` reads the user's usage (`month_spend`) and the server total (`month_spend_all`); a row in `allowed_emails` overrides that user's cap (0 blocks). `OPEN_SIGNUP=false` makes the list an allowlist. It fails closed if Supabase cannot be reached. While a run is going, `onUsage` meters each step (`costOf`: the reported cost, else a high token estimate) and aborts the run when the user's allowance is used up. Every chat is logged to `usage` even when it fails or is stopped. At most 6 chats per user per minute.
- **Supabase setup** (SQL editor): tables `allowed_emails(email pk, monthly_cap_usd)` and `usage(user_id, email, model, tokens_in, tokens_out, cost_usd, created_at)` with row-level security on, functions `month_spend(uid)` and `month_spend_all()`, privileges granted to `service_role` only. Google provider on in Authentication → Providers, with `https://<project>.supabase.co/auth/v1/callback` as the Google redirect URI; Site URL = the app's URL, plus `http://127.0.0.1:8430` in the redirect list for local testing. Optional `PUBLIC_URL` overrides the origin used for the return address.
- Projects live in `VOLTBRIDGE_SESSIONS` (`/data/sessions` in the image). Without a persistent disk mounted there they vanish on redeploy; storing them in Supabase is the next step.
- `npm test` covers `auth.js` against a fake Supabase (cookie forgery and expiry, caps, fail-closed). The server-level flow (two users, isolation, caps, rate limit) was checked with a throwaway script that starts the real server against fake Supabase and OpenRouter servers; it is not in the repo.

## Git

Local repository only, no remote. Commits: `591a1f2` initial app, `62e344e` distribution boards (multi-pole devices, pole marking, loads, circuit props/table, ref prefixes, RTL text, array op, overlap check). The original feature requests are in `~/ioe/schematics/voltbridge-dev-requests.md`.
