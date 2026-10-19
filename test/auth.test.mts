import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { pack, pendingTag, readPending, startSignIn, unpack } from '../src/auth.ts';

// workerd has crypto.subtle.timingSafeEqual; Node does not.
(crypto.subtle as any).timingSafeEqual ??= (a: ArrayBuffer, b: ArrayBuffer) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const env = { OWNER_PASSWORD: 'correct horse battery staple' } as any; // no KV on purpose: signing in must not need one
const ORIGIN = 'https://example.test';
const pOf = (url: string) => new URL(url).searchParams.get('p')!;

test('pack/unpack survive non-Latin1 text', () => {
  const o = { state: 'привет 🙂 日本語', n: 1 };
  assert.deepEqual(unpack(pack(o)), o);
  assert.match(pack(o), /^[A-Za-z0-9_-]+$/, 'url-safe, no padding');
});

test('a sign-in round-trips without touching storage', async () => {
  const pending = { oauth: { clientId: 'c1', state: 'ß✓' }, client: { name: 'App', host: 'app.test' } };
  const s = await startSignIn(env, ORIGIN, pending);
  assert.ok(s);
  assert.deepEqual(await readPending(env, pOf(s.url)), pending);
  assert.equal(s.id, await pendingTag(pOf(s.url)), 'the cookie tag is derived from the link');
});

test('a forged, edited or expired sign-in is rejected', async () => {
  const s = (await startSignIn(env, ORIGIN, { oauth: { clientId: 'c1' } }))!;
  const p = pOf(s.url);
  const [body, sig] = p.split('.');

  assert.equal(await readPending(env, `${pack({ exp: Date.now() + 1e6, pending: { oauth: { clientId: 'evil' } } })}.${sig}`), null, 'edited body');
  assert.equal(await readPending(env, `${body}.${'0'.repeat(32)}`), null, 'wrong signature');
  assert.equal(await readPending(env, `${body}`), null, 'no signature');
  assert.equal(await readPending(env, 'garbage'), null);
  assert.equal(await readPending({ OWNER_PASSWORD: 'another password entirely' } as any, p), null, 'signed under a different password');

  const realNow = Date.now;
  Date.now = () => realNow() + 3601 * 1000;
  try {
    assert.equal(await readPending(env, p), null, 'expired after an hour');
  } finally {
    Date.now = realNow;
  }
});

test('no password, or an oversized request, means no sign-in', async () => {
  assert.equal(await startSignIn({} as any, ORIGIN, {}), null);
  assert.equal(await startSignIn({ OWNER_PASSWORD: 'short' } as any, ORIGIN, {}), null);
  assert.equal(await startSignIn(env, ORIGIN, { oauth: { state: 'x'.repeat(10_000) } }), null);
});
