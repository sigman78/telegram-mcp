/**
 * Who counts as the owner: whoever knows OWNER_PASSWORD. A good password buys a 30 minute bearer token for the
 * link page's /link/* calls, plus a cookie so this browser can skip signing in for two weeks.
 *
 * Adapted from finereli/whatsapp-mcp (MIT), password mode only.
 */
import type { Env } from './env.js';

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

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

/** JSON <-> base64url, safe for non-Latin1 text (a plain btoa throws on it). */
export function pack(o: unknown): string {
  let bin = '';
  for (const b of enc.encode(JSON.stringify(o))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unpack(s: string): any {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

const PENDING_SECONDS = 3600;
const PENDING_MAX_CHARS = 6000;

/**
 * What a sign-in is waiting on travels in the sign-in URL itself, signed with the owner password, so starting one
 * writes nothing: an anonymous visitor can't use up the KV write quota with it. The cost is that a link can be
 * reused until it expires (an hour); using it still takes the password, in the browser that started it.
 * Returns null if the password isn't set up or the request is too large to carry.
 */
export async function startSignIn(env: Env, origin: string, pending: Pending): Promise<{ id: string; url: string } | null> {
  const key = secret(env);
  if (!key) return null;
  const body = pack({ exp: Date.now() + PENDING_SECONDS * 1000, pending });
  const p = `${body}.${(await hmac(key, `pending:${body}`)).slice(0, 32)}`;
  if (p.length > PENDING_MAX_CHARS) return null;
  return { id: await pendingTag(p), url: `${origin}/login?p=${p}` };
}

/** A short stable name for one sign-in, used in the cookie name (the sign-in itself is too long for that). */
export async function pendingTag(p: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(p))).slice(0, 24);
}

/**
 * An approval request is tied to the browser that made it: /authorize sets this cookie, and /login insists on it.
 * Without it, anyone could start a request for their own client and hand the owner the resulting sign-in link.
 */
export const pendingCookieName = (tag: string) => `tg_pend_${tag}`;
export const pendingCookie = (tag: string, maxAge = PENDING_SECONDS) =>
  `${pendingCookieName(tag)}=1; Path=/login; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

/** The signed request carried by `?p=`, or null if it is forged, expired or malformed. */
export async function readPending(env: Env, p: string): Promise<Pending | null> {
  const key = secret(env);
  const [body, sig] = p.split('.');
  if (!key || !body || !sig || p.length > PENDING_MAX_CHARS) return null;
  if (!(await sameSecret(sig, (await hmac(key, `pending:${body}`)).slice(0, 32)))) return null;
  try {
    const { exp, pending } = unpack(body);
    return Number(exp) >= Date.now() ? (pending as Pending) : null;
  } catch {
    return null;
  }
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
