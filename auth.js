// Google sign-in through Supabase for a hosted server, plus the spending caps. The browser only ever holds our own signed
// cookie; the Supabase service key stays on the server and is used for the user check, the allowance tables and the usage log.
import crypto from 'node:crypto';

const b64 = (s) => Buffer.from(s).toString('base64url');
const DAY = 86400000;

// Options: url, serviceKey (Supabase), userCap / globalCap (dollars per calendar month, UTC), open (anyone with a Google account
// may sign in; false = only emails listed in allowed_emails), secret (cookie signing; derived from the service key by default).
export function createAuth({ url, serviceKey, userCap = 0.5, globalCap = 10, open = true, secret, fetchFn = fetch, now = Date.now }) {
  url = url.replace(/\/$/, '');
  const key = secret || crypto.createHash('sha256').update(`voltbridge-session:${serviceKey}`).digest('hex');
  const mac = (s) => crypto.createHmac('sha256', key).update(s).digest('base64url');

  // Supabase's new secret keys (sb_secret_...) are not JWTs and go in the apikey header only; the legacy service_role key is a JWT
  // and also goes in Authorization.
  const bearer = serviceKey.startsWith('sb_') ? {} : { authorization: `Bearer ${serviceKey}` };
  const api = async (path, init = {}) => {
    const res = await fetchFn(`${url}${path}`, { ...init, headers: { apikey: serviceKey, ...bearer, 'content-type': 'application/json', ...init.headers } });
    if (!res.ok) throw new Error(`Supabase ${res.status} on ${path.split('?')[0]}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  };
  const rpc = async (name, args) => Number(await api(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args) })) || 0;

  return {
    userCap, globalCap,

    // our session cookie value: base64url(json).mac, valid for `days`
    sign(user, days = 7) {
      const body = b64(JSON.stringify({ id: user.id, email: user.email, exp: now() + days * DAY }));
      return `${body}.${mac(body)}`;
    },
    // the signed-in user in a Cookie header, or null (missing, forged or expired)
    read(cookieHeader) {
      const v = /(?:^|;\s*)vb=([^;]+)/.exec(cookieHeader || '')?.[1];
      const [body, tag] = (v || '').split('.');
      if (!body || !tag) return null;
      const want = Buffer.from(mac(body)), got = Buffer.from(tag);
      if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
      try {
        const j = JSON.parse(Buffer.from(body, 'base64url').toString());
        return j.exp > now() && j.id && j.email ? { id: j.id, email: j.email } : null;
      } catch { return null; }
    },

    // the access token Supabase gives the browser after Google sign-in -> {id, email}, or throws
    async login(accessToken) {
      const res = await fetchFn(`${url}/auth/v1/user`, { headers: { apikey: serviceKey, authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error('Sign-in was not accepted. Try again.');
      const u = await res.json();
      if (!u.id || !u.email || !(u.email_confirmed_at || u.confirmed_at)) throw new Error('Your Google account has no verified email address.');
      return { id: u.id, email: String(u.email).toLowerCase() };
    },

    // may this user chat now? {ok, cap, spent} or {ok:false, reason}. Fails closed when Supabase cannot be reached.
    async limits(user) {
      try {
        const [row] = (await api(`/rest/v1/allowed_emails?select=monthly_cap_usd&email=eq.${encodeURIComponent(user.email)}`)) || [];
        if (!row && !open) return { ok: false, reason: 'This account is not on the access list.' };
        const cap = row ? Number(row.monthly_cap_usd) : userCap;
        const [spent, all] = await Promise.all([rpc('month_spend', { uid: user.id }), rpc('month_spend_all', {})]);
        if (all >= globalCap) return { ok: false, reason: 'Voltbridge has reached its budget for this month. Please try again next month.' };
        if (spent >= cap) return { ok: false, reason: `You have used your allowance for this month ($${cap.toFixed(2)}). It resets on the 1st.` };
        return { ok: true, cap, spent };
      } catch (e) {
        console.error('[auth]', e.message);
        return { ok: false, reason: 'Could not check your allowance right now. Please try again in a minute.' };
      }
    },

    async record(user, { model, prompt = 0, output = 0, cost = 0 }) {
      try {
        await api('/rest/v1/usage', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ user_id: user.id, email: user.email, model, tokens_in: prompt, tokens_out: output, cost_usd: cost }) });
      } catch (e) { console.error('[auth] usage not recorded:', e.message); }
    },
  };
}

// Dollars for one step: what the provider reported, else a deliberately high estimate so a missing figure cannot bypass the caps.
export const costOf = (u) => (u.cost != null ? u.cost : ((u.prompt || 0) * 1 + (u.output || 0) * 5) / 1e6);
