/**
 * telegram-mcp - a read-only MCP server over your own Telegram account, on Cloudflare Workers.
 *
 * OAuth (workers-oauth-provider) fronts /mcp. Approving a client means signing in as the owner with a password
 * (see auth.ts); if Telegram isn't linked yet, the same flow continues into the QR screen, so a first connection
 * links the account and a later one just signs in. Structure adapted from finereli/whatsapp-mcp (MIT).
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { TelegramSession } from './telegram-do.js';
import { handleMcp } from './mcp.js';
import { consentPage, landingPage, linkPage, loginPage, messagePage } from './pages.js';
import {
  isOwnerToken, mintSession, pack, pendingCookie, pendingCookieName, pendingTag, readPending, sessionCookie, sessionToken, SESSION_COOKIE,
  startSignIn, tokenFromPassword, unpack,
} from './auth.js';
import type { Env } from './env.js';

export { TelegramSession };

const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const tg = (env: Env) => env.TG.get(env.TG.idFromName('owner'));
const cookieValue = (r: Request, name: string) => r.headers.get('cookie')?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
const bearer = (r: Request) => r.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
const plain = (title: string, msg: string, status: number, headers: Record<string, string> = {}) => {
  const res = html(messagePage(title, msg), status);
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
};
const hostOf = (uri: string) => {
  try { return new URL(uri).host || uri; } catch { return uri; }
};

async function completeOauth(env: Env, oauth: unknown) {
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauth as any, userId: 'owner', scope: ['telegram'], metadata: {}, props: { userId: 'owner' },
  });
  return redirectTo;
}

/** The owner is verified. Remember this browser, then finish the MCP grant if Telegram is linked, else go on to the QR screen. */
async function proceed(env: Env, p: string, token: string): Promise<Response> {
  const pending = await readPending(env, p);
  if (!pending) return plain('Sign-in expired', 'Start again from the app that asked.', 400);
  const session = await mintSession(env);
  const tag = await pendingTag(p);
  const remember = (res: Response) => {
    const out = new Response(res.body, res);
    if (session) out.headers.append('set-cookie', sessionCookie(session.value, session.maxAge));
    out.headers.append('set-cookie', pendingCookie(tag, 0)); // done with this browser binding
    return out;
  };
  if (pending.oauth && (await tg(env).isLinked())) {
    return remember(new Response(null, { status: 302, headers: { location: await completeOauth(env, pending.oauth) } }));
  }
  return remember(html(linkPage(token, pending.oauth ? pack(pending.oauth) : null)));
}

const ownerHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const p = url.searchParams.get('p') ?? '';

    if (path === '/') {
      const token = await sessionToken(env, cookieValue(request, SESSION_COOKIE));
      return html(token ? linkPage(token, null) : landingPage());
    }
    if (path === '/signout') return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': sessionCookie('', 0) } });

    // An MCP client wants in: show who is asking, then send the owner to sign in.
    if (path === '/authorize') {
      let oauth: Awaited<ReturnType<typeof env.OAUTH_PROVIDER.parseAuthRequest>>;
      try {
        oauth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch {
        return plain('Invalid request', 'This approval request is not valid. Start again from the app that asked.', 400);
      }
      const client = oauth.clientId ? await env.OAUTH_PROVIDER.lookupClient(oauth.clientId) : null;
      if (!client) return plain('Unknown app', 'This request names no registered app. Start again from the app that asked.', 400);
      const who = { name: client.clientName ?? 'An app', host: hostOf(oauth.redirectUri) };
      const started = await startSignIn(env, url.origin, { oauth, client: who });
      if (!started) return plain('Cannot start sign-in', 'The OWNER_PASSWORD secret is missing (12+ characters), or this request is too large.', 503);
      const res = html(consentPage(who.name, who.host, started.url));
      res.headers.append('set-cookie', pendingCookie(started.id)); // ties this request to this browser
      return res;
    }
    if (path === '/setup') {
      if (await sessionToken(env, cookieValue(request, SESSION_COOKIE))) return Response.redirect(`${url.origin}/`, 302);
      const started = await startSignIn(env, url.origin, {});
      return started ? Response.redirect(started.url, 302) : plain('Not set up', 'Set the OWNER_PASSWORD secret (12+ characters) and reload.', 503);
    }

    if (path === '/login') {
      if (!env.OWNER_PASSWORD || env.OWNER_PASSWORD.length < 12) return plain('Not set up', 'Set the OWNER_PASSWORD secret (12+ characters) and reload.', 503);
      const pending = await readPending(env, p);
      if (!pending) return plain('Sign-in expired', 'Start again from the setup page.', 400);
      // An approval request only continues in the browser that started it, so a forwarded link cannot approve someone else's app.
      if (pending.oauth && !cookieValue(request, pendingCookieName(await pendingTag(p)))) {
        return plain('Wrong browser', 'This approval link belongs to another browser session. Start again from the app that wants access, in this browser.', 403);
      }
      if (request.method !== 'POST') return html(loginPage(url.pathname + url.search, undefined, pending.client));
      const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
      const gate = await tg(env).loginBegin(ip);
      if (!gate.ok) {
        return plain('Too many attempts', `Wait about ${Math.ceil(gate.retryAfter / 60)} minute(s) and try again.`, 429, { 'retry-after': String(gate.retryAfter) });
      }
      const token = await tokenFromPassword(env, String((await request.formData()).get('password') ?? ''));
      if (!token) return html(loginPage(url.pathname + url.search, 'Wrong password.', pending.client), 401);
      await tg(env).loginSucceeded(ip);
      return proceed(env, p, token);
    }

    if (path.startsWith('/link/')) {
      if (!(await isOwnerToken(env, bearer(request)))) return json({ error: 'unauthorized' }, 401);
      if (path === '/link/status') return json(await tg(env).linkStatus());
      if (request.method === 'POST') {
        if (path === '/link/start') { await tg(env).startLink(); return json({ ok: true }); }
        if (path === '/link/password') {
          const { password } = (await request.json()) as { password: string };
          return json({ ok: await tg(env).submitPassword(String(password ?? '')) });
        }
        if (path === '/link/relink') { await tg(env).logout(); return json({ ok: true }); }
        if (path === '/link/finish') {
          if (!(await tg(env).isLinked())) return json({ error: 'not linked' }, 409);
          const { req } = (await request.json()) as { req: string };
          return json({ redirectTo: await completeOauth(env, unpack(req)) });
        }
      }
    }

    return new Response('Not found', { status: 404 });
  },
};

const oauth = new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: { fetch: (request: Request, env: Env) => handleMcp(request, env) } as any,
  defaultHandler: ownerHandler as any,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: ['telegram'],
  refreshTokenTTL: 10 * 365 * 24 * 60 * 60,
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => oauth.fetch(request, env, ctx),
};
