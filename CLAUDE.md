# voltbridge

Claude chat + electrical schematic editor. Read docs/DEVELOPING.md before changing code; README.md is the user guide.

- The model is `web/schematic.js`, shared by server and browser. Keep it DOM-free.
- When an edit op changes, update `OPS_DOC` in lib.js and, if it is a drawing convention, `PROMPT` in server.js.
- Don't replace the bidi handling (`visual()` / `T()`) with plain text: resvg would render Hebrew reversed.
- Verify with `npm test`, then look at `test-out/*.png`.
- The server runs Claude with bypassPermissions. Never change the localhost default bind.
