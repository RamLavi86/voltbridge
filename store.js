// Keeps each hosted user's sessions in Supabase, because the server's own disk is lost on every restart and redeploy.
// The sessions folder stays the working copy; this mirrors it into the user_files table and restores it on first use.
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE = 8e6, MAX_FILES = 600, BATCH = 8;
const SAFE = /^[\w .@()+-]+(\/[\w .@()+-]+)*$/; // relative paths of our own making; rejects '..', absolute paths and backslashes

// api is the Supabase REST caller from auth.js (throws on a non-2xx answer with the key already redacted)
export function createStore(api) {
  const states = new Map(); // user id -> { known: Map<path, "mtime:size" as last stored>, restored, chain }
  const st = (id) => states.get(id) || states.set(id, { known: new Map(), restored: false, chain: Promise.resolve() }).get(id);
  const run = (user, fn) => { const s = st(user.id); return (s.chain = s.chain.then(fn).catch((e) => console.error('[store]', e.message))); };
  const sig = (f) => { try { const x = fs.statSync(f); return { size: x.size, sig: `${x.mtimeMs}:${x.size}` }; } catch { return null; } };

  // every file inside a session folder (a folder holding session.json), as paths relative to the user's root
  const files = (root) => {
    const out = [];
    const walk = (dir, rel, inSession) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      const session = inSession || ents.some((e) => e.isFile() && e.name === 'session.json');
      for (const e of ents) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), p, session);
        else if (session && e.isFile()) out.push(p);
      }
    };
    walk(root, '', false);
    return out;
  };

  async function restoreNow(user) {
    const s = st(user.id);
    if (s.restored) return;
    try {
      const rows = (await api(`/rest/v1/user_files?user_id=eq.${encodeURIComponent(user.id)}&select=path,data&order=path&limit=5000`)) || [];
      for (const r of rows) {
        if (!SAFE.test(r.path)) continue;
        const f = path.join(user.root, r.path);
        if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); }
        const x = sig(f);
        if (x && fs.readFileSync(f).equals(Buffer.from(r.data, 'base64'))) s.known.set(r.path, x.sig); // unchanged copies need no upload
      }
      s.restored = true;
    } catch (e) { console.error('[store] could not restore', e.message); } // push stays off until a restore works, so an empty folder never overwrites saved work
  }

  async function pushNow(user) {
    const s = st(user.id);
    if (!s.restored) await restoreNow(user);
    if (!s.restored) return;
    const now = new Map(), todo = [];
    for (const rel of files(user.root).slice(0, MAX_FILES)) {
      const x = sig(path.join(user.root, rel));
      if (!x || x.size > MAX_FILE) continue;
      now.set(rel, x.sig);
      if (s.known.get(rel) !== x.sig) todo.push(rel);
    }
    for (let i = 0; i < todo.length; i += BATCH) {
      const part = todo.slice(i, i + BATCH);
      const rows = part.map((rel) => ({ user_id: user.id, path: rel, data: fs.readFileSync(path.join(user.root, rel)).toString('base64'), updated_at: new Date().toISOString() }));
      await api('/rest/v1/user_files?on_conflict=user_id,path', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
      for (const rel of part) s.known.set(rel, now.get(rel));
    }
    for (const rel of [...s.known.keys()].filter((p) => !now.has(p))) { // deleted or renamed on disk
      await api(`/rest/v1/user_files?user_id=eq.${encodeURIComponent(user.id)}&path=eq.${encodeURIComponent(rel)}`, { method: 'DELETE' });
      s.known.delete(rel);
    }
  }

  return {
    restore: (user) => run(user, () => restoreNow(user)), // resolves when the folder is ready; never rejects
    push: (user) => run(user, () => pushNow(user)),
  };
}
