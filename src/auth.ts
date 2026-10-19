/**
 * Who counts as the owner: whoever knows OWNER_PASSWORD. A good password buys a 30 minute bearer token for the
 * link page's /link/* calls, plus a cookie so this browser can skip signing in for two weeks.
 *
 * Adapted from finereli/whatsapp-mcp (MIT), password mode only.
 */
import type { Env } from './env.js';

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const randomId = () => hex(crypto.getRandomValues(new Uint8Array(16)).buffer);

async function hmac(key: string, msg: string) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

/** Constant-time comparison (hash both sides first so lengths don't leak). */
export async function sameSecret(a: string, b: string) {
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return (crypto.subtle as any).timingSafeEqual(x, y) as boolean;
}

const secret = (env: Env) => (env.OWNER_PASSWORD && env.OWNER_PASSWORD.length >= 12 ? env.OWNER_PASSWORD : null);

/** What a sign-in is waiting on: an MCP client's approval request (with who is asking, for display), or nothing (plain setup). */
export interface Pending {
  oauth?: any;
  client?: { name: string; host: string };
}

/** Park what we need after sign-in. Returns its id and the URL that starts it. */
export async function startSignIn(env: Env, origin: string, pending: Pending): Promise<{ id: string; url: string }> {
  const id = randomId();
  await env.OAUTH_KV.put(`pending:${id}`, JSON.stringify(pending), { expirationTtl: 3600 });
  return { id, url: `${origin}/login?p=${id}` };
}

/**
 * An approval request is tied to the browser that made it: /authorize sets this cookie, and /login insists on it.
 * Without it, anyone could start a request for their own client and hand the owner the resulting sign-in link.
 */
export const pendingCookieName = (id: string) => `tg_pend_${id}`;
export const pendingCookie = (id: string, maxAge = 3600) =>
  `${pendingCookieName(id)}=1; Path=/login; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

export async function peekPending(env: Env, id: string): Promise<Pending | null> {
  const raw = await env.OAUTH_KV.get(`pending:${id}`);
  return raw ? JSON.parse(raw) : null;
}
export async function takePending(env: Env, id: string) {
  const p = await peekPending(env, id);
  if (p) await env.OAUTH_KV.delete(`pending:${id}`);
  return p;
}

/** A 30 minute bearer token for the link page. */
export async function mintToken(env: Env): Promise<string | null> {
  const key = secret(env);
  if (!key) return null;
  const exp = String(Date.now() + 30 * 60_000);
  return `${exp}.${await hmac(key, `link:${exp}`)}`;
}
export async function tokenFromPassword(env: Env, password: string): Promise<string | null> {
  const key = secret(env);
  return key && (await sameSecret(password, key)) ? mintToken(env) : null;
}
export async function isOwnerToken(env: Env, token: string | undefined): Promise<boolean> {
  const key = secret(env);
  const [exp, sig] = (token ?? '').split('.');
  if (!key || !exp || !sig || Number(exp) < Date.now()) return false;
  return sameSecret(sig, await hmac(key, `link:${exp}`));
}

// ---------- the owner's browser session ----------

export const SESSION_COOKIE = 'tg_session';
const SESSION_SECONDS = 14 * 86_400;

export async function mintSession(env: Env): Promise<{ value: string; maxAge: number } | null> {
  const key = secret(env);
  if (!key) return null;
  const exp = String(Date.now() + SESSION_SECONDS * 1000);
  return { value: `${exp}.${await hmac(key, `session:${exp}`)}`, maxAge: SESSION_SECONDS };
}
/** If the cookie is a valid owner session, a fresh bearer token for the link page. Otherwise null. */
export async function sessionToken(env: Env, cookie: string | undefined): Promise<string | null> {
  const key = secret(env);
  const [exp, sig] = (cookie ?? '').split('.');
  if (!key || !exp || !sig || Number(exp) < Date.now()) return null;
  return (await sameSecret(sig, await hmac(key, `session:${exp}`))) ? mintToken(env) : null;
}
export const sessionCookie = (value: string, maxAge: number) =>
  `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
