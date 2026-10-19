/**
 * The one Durable Object that owns the Telegram login. Its SQLite holds the mtcute session (storage.ts). Unlike a
 * WhatsApp linked device, Telegram keeps the whole history server-side, so nothing is mirrored here: every read is a
 * live call. The connection is opened on demand and closed again after a short idle period.
 */
import { DurableObject } from 'cloudflare:workers';
import { BaseTelegramClient, TelegramClient, WebCryptoProvider, getMarkedPeerId } from '@mtcute/web';
import type { Message } from '@mtcute/web';
// @ts-expect-error the CompiledWasm rule in wrangler.jsonc turns this import into a WebAssembly.Module
import wasmModule from '../node_modules/@mtcute/wasm/mtcute.wasm';
import qrcode from 'qrcode-generator';
import { DoSqliteStorage } from './storage.js';
import type { Env } from './env.js';

/** How many dialogs we are willing to scan when looking a chat up by name. */
const MAX_DIALOGS = 500;
const DIALOG_CACHE_MS = 2 * 60_000;
const IDLE_CLOSE_MS = 30_000;
const AUTH_LOST = /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/;

export class NotLinkedError extends Error {}

export interface ChatRow {
  id: number;
  name: string;
  type: string;
  username: string | null;
  unread: number;
  lastTs: number;
  lastText: string;
}
export interface MsgRow {
  id: number;
  ts: number;
  from: string;
  fromMe: boolean;
  chatId: number;
  chat: string;
  text: string;
  replyTo: number | null;
}
export interface LinkStatus {
  linked: boolean;
  me: { id: number; name: string; username: string | null } | null;
  phase: 'idle' | 'qr' | 'scanned' | 'password' | 'done' | 'error';
  qrSvg: string | null;
  expires: number | null;
  error: string | null;
  /** Which password prompt this is; changes after every rejected password. */
  attempt: number;
  configured: boolean;
}

/** One-line description of what a message carries besides text. */
function mediaLabel(m: Message): string {
  const media = m.media as any;
  if (!media) return '';
  const secs = media.duration ? ` ${Math.round(media.duration)}s` : '';
  switch (media.type) {
    case 'voice': return `[voice note${secs}]`;
    case 'video': return `[${media.isRound ? 'video note' : media.isAnimation ? 'gif' : 'video'}${secs}]`;
    case 'document': return `[document${media.fileName ? ` ${media.fileName}` : ''}]`;
    case 'audio': return `[audio${media.title ? ` ${media.title}` : ''}${secs}]`;
    case 'sticker': return `[sticker${media.emoji ? ` ${media.emoji}` : ''}]`;
    case 'poll': return `[poll: ${media.question?.text ?? media.question ?? ''}]`;
    case 'webpage': return '';
    default: return `[${media.type}]`;
  }
}

function render(m: Message): string {
  if (m.isService) return `[${m.action?.type ?? 'service message'}]`;
  const parts = [mediaLabel(m), m.text].filter(Boolean);
  return (m.forward ? '[forwarded] ' : '') + (parts.join(' ') || '[empty]');
}

const msgRow = (m: Message): MsgRow => ({
  id: m.id,
  ts: Math.floor(m.date.getTime() / 1000),
  from: m.sender.displayName,
  fromMe: m.isOutgoing,
  chatId: m.chat.id,
  chat: m.chat.displayName,
  text: render(m),
  replyTo: (m.replyToMessage as any)?.id ?? null,
});

export class TelegramSession extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  private storage = new DoSqliteStorage(this.sql);
  private tg?: TelegramClient;
  private tgReady?: Promise<TelegramClient>;
  private lastUse = 0;
  /** Calls currently using the client. The idle alarm must never close a client someone is still waiting on. */
  private inFlight = 0;
  private dialogCache?: { at: number; rows: ChatRow[] };

  private link: { phase: LinkStatus['phase']; url?: string; expires?: number; error?: string } = { phase: 'idle' };
  private linkRun?: Promise<void>;
  private linkAbort?: AbortController;
  private wantPassword?: (pw: string) => void;
  /** Counts password prompts, so the setup page can tell a fresh prompt (after a wrong password) from the one it already shows. */
  private pwAttempt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS login_attempts (ts INTEGER NOT NULL, ip TEXT NOT NULL, ok INTEGER NOT NULL)');
  }

  // ---------- state ----------

  private getMeta(k: string): string | null {
    return (this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]?.v as string | undefined) ?? null;
  }
  private setMeta(k: string, v: string) {
    this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, v);
  }
  private me(): LinkStatus['me'] {
    const raw = this.getMeta('me');
    return raw ? JSON.parse(raw) : null;
  }
  private configured = () => Boolean(this.env.TG_API_ID && this.env.TG_API_HASH);

  isLinked(): boolean {
    return this.me() !== null;
  }

  linkStatus(): LinkStatus {
    let qrSvg: string | null = null;
    if (this.link.phase === 'qr' && this.link.url) {
      const qr = qrcode(0, 'M');
      qr.addData(this.link.url);
      qr.make();
      qrSvg = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    }
    return {
      linked: this.isLinked(),
      me: this.me(),
      phase: this.isLinked() && this.link.phase !== 'password' ? 'done' : this.link.phase,
      qrSvg,
      expires: this.link.expires ?? null,
      error: this.link.error ?? null,
      attempt: this.pwAttempt,
      configured: this.configured(),
    };
  }

  // ---------- client lifecycle ----------

  private makeClient(): TelegramClient {
    const base = new BaseTelegramClient({
      apiId: Number(this.env.TG_API_ID),
      apiHash: this.env.TG_API_HASH,
      storage: this.storage,
      crypto: new WebCryptoProvider({ wasmInput: wasmModule }),
      // No update stream: we only read on demand. This must be set on the base client (the wrapper's disableUpdates
      // does not reach it). QR login still works, because scan notices come through the raw onServerUpdate hook.
      updates: false,
    });
    return new TelegramClient({ client: base, disableUpdates: true });
  }

  private async closeClient() {
    const tg = this.tg;
    this.tg = undefined;
    this.tgReady = undefined;
    try { await tg?.destroy(); } catch { /* already gone */ }
  }

  /** Run `fn` against a connected client, connecting first if needed, and keep the connection warm for a bit. */
  private async use<T>(fn: (tg: TelegramClient) => Promise<T>): Promise<T> {
    if (!this.configured()) throw new Error('TG_API_ID and TG_API_HASH are not set on this deployment.');
    if (!this.isLinked()) throw new NotLinkedError('Telegram is not linked yet.');
    this.tgReady ??= (async () => {
      const tg = this.makeClient();
      await tg.connect();
      this.tg = tg;
      return tg;
    })().catch((e) => { this.tgReady = undefined; throw e; });
    this.inFlight++;
    try {
      const tg = await this.tgReady;
      this.lastUse = Date.now();
      if (!this.linkRun) await this.ctx.storage.setAlarm(Date.now() + IDLE_CLOSE_MS);
      return await fn(tg);
    } catch (e: any) {
      if (AUTH_LOST.test(String(e?.text ?? e?.message ?? e))) {
        await this.forget();
        throw new NotLinkedError('Telegram is not linked any more: it ended this session (revoked from the phone, or the account changed). Link again.');
      }
      throw e;
    } finally {
      this.inFlight--;
      this.lastUse = Date.now(); // idle time counts from when the last call ENDED
    }
  }

  async alarm() {
    if (this.linkRun) await this.linkRun;
    if (!this.tg) return;
    if (this.inFlight === 0 && Date.now() - this.lastUse >= IDLE_CLOSE_MS - 1000) await this.closeClient();
    else await this.ctx.storage.setAlarm(Date.now() + IDLE_CLOSE_MS);
  }

  // ---------- linking ----------

  /** Begin the QR login. Idempotent: returns at once if linked or already running. */
  async startLink(): Promise<void> {
    if (!this.configured() || this.isLinked() || this.linkRun) return;
    // Claim the slot before the first await, so two overlapping calls (the setup page polls) cannot start two logins.
    this.linkAbort = new AbortController();
    this.link = { phase: 'qr' };
    this.pwAttempt = 0;
    this.linkRun = (async () => {
      await this.closeClient();
      this.storage.wipe(); // a half-finished earlier attempt must not leave a stale key behind
      await this.runLink(this.makeClient());
    })()
      .catch((e: any) => { this.link = { phase: 'error', error: String(e?.message ?? e) }; })
      .finally(() => { this.linkRun = undefined; });
    // An in-flight alarm handler is what keeps this object alive while the user finds their phone.
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  private async runLink(tg: TelegramClient) {
    try {
      await tg.connect();
      const user = await tg.signInQr({
        onUrlUpdated: (url, expires) => { this.link = { phase: 'qr', url, expires: expires.getTime() }; },
        onQrScanned: () => { this.link = { phase: 'scanned' }; },
        password: () => this.askPassword(),
        invalidPasswordCallback: () => { this.link = { ...this.link, error: 'That password was not accepted. Try again.' }; },
        abortSignal: this.linkAbort!.signal,
      });
      this.setMeta('me', JSON.stringify({ id: user.id, name: user.displayName, username: user.username }));
      this.link = { phase: 'done' };
      this.tg = tg;
      this.tgReady = Promise.resolve(tg);
      this.lastUse = Date.now();
    } catch (e: any) {
      this.link = { phase: 'error', error: this.linkAbort?.signal.aborted ? 'Cancelled.' : String(e?.text ?? e?.message ?? e) };
      try { await tg.destroy(); } catch { /* ignore */ }
      this.storage.wipe();
    }
  }

  private askPassword(): Promise<string> {
    this.pwAttempt++;
    this.link = { phase: 'password', error: this.link.error };
    return new Promise((resolve) => { this.wantPassword = resolve; });
  }

  /** The account has two-step verification on: hand the password to the login that is waiting for it. */
  submitPassword(password: string): boolean {
    if (!this.wantPassword) return false;
    const resolve = this.wantPassword;
    this.wantPassword = undefined;
    this.link = { phase: 'scanned' };
    resolve(password);
    return true;
  }

  cancelLink() {
    this.linkAbort?.abort();
    this.wantPassword?.('');
  }

  /** Drop the local login without telling Telegram (used when Telegram already ended the session). */
  private async forget() {
    await this.closeClient();
    this.sql.exec("DELETE FROM meta WHERE k = 'me'");
    this.storage.wipe();
    this.dialogCache = undefined;
    this.link = { phase: 'idle' };
  }

  /** End the session on Telegram's side too, so the device disappears from the phone's list. */
  async logout(): Promise<{ remote: boolean }> {
    this.cancelLink();
    let remote = false;
    if (this.isLinked() && this.configured()) {
      try { await this.use((tg) => tg.logOut()); remote = true; } catch { /* fall through and forget locally */ }
    }
    await this.forget();
    return { remote };
  }

  // ---------- reading ----------

  private async allDialogs(): Promise<ChatRow[]> {
    if (this.dialogCache && Date.now() - this.dialogCache.at < DIALOG_CACHE_MS) return this.dialogCache.rows;
    const rows = await this.use(async (tg) => {
      const out: ChatRow[] = [];
      for await (const d of tg.iterDialogs({ limit: MAX_DIALOGS, archived: 'keep' })) {
        const p = d.peer as any;
        const last = d.lastMessage;
        out.push({
          id: p.id,
          name: p.isSelf ? 'Saved Messages' : p.displayName,
          type: p.type === 'user' ? (p.isBot ? 'bot' : 'user') : p.chatType,
          username: p.username ?? null,
          unread: d.unreadCount,
          lastTs: last ? Math.floor(last.date.getTime() / 1000) : 0,
          lastText: last ? render(last).replace(/\s+/g, ' ').slice(0, 120) : '',
        });
      }
      return out;
    });
    this.dialogCache = { at: Date.now(), rows };
    return rows;
  }

  async chats(query: string | undefined, limit: number): Promise<ChatRow[]> {
    const q = query?.trim().toLowerCase();
    const rows = await this.allDialogs();
    const hit = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.username?.toLowerCase().includes(q) || String(r.id) === q) : rows;
    return hit.slice(0, limit);
  }

  /** Turn "Dana", "@dana", or a numeric id into chats. An exact name match beats partial ones. */
  async resolveChat(ref: string): Promise<{ id: number; name: string }[]> {
    const r = ref.trim();
    const rows = await this.allDialogs();
    if (/^-?\d+$/.test(r)) {
      const hit = rows.find((x) => x.id === Number(r));
      return [{ id: Number(r), name: hit?.name ?? r }];
    }
    const lower = r.replace(/^@/, '').toLowerCase();
    const byUser = rows.find((x) => x.username?.toLowerCase() === lower);
    if (byUser) return [{ id: byUser.id, name: byUser.name }];
    if (r.startsWith('@')) {
      // An explicit @username means a username and nothing else: never fall back to chat titles ("@dana" is not "Dana family").
      return this.use(async (tg) => {
        try {
          const peer = await tg.resolvePeer(r);
          return [{ id: getMarkedPeerId(peer), name: r }];
        } catch (e: any) {
          if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID/.test(String(e?.text ?? e?.message ?? e))) return [];
          throw e;
        }
      });
    }
    const exact = rows.filter((x) => x.name.toLowerCase() === lower);
    const found = exact.length ? exact : rows.filter((x) => x.name.toLowerCase().includes(lower));
    return found.map((x) => ({ id: x.id, name: x.name }));
  }

  /**
   * The newest `limit` messages in a window, returned oldest first. `beforeId` (a message id) is the exact way to page back;
   * `before` and `after` are epoch seconds and only as precise as a second.
   */
  async messages(p: { chat: number; limit: number; beforeId?: number; before?: number; after?: number }): Promise<MsgRow[]> {
    return this.use(async (tg) => {
      const out: MsgRow[] = [];
      let offset: { id: number; date: number } | undefined = p.beforeId ? { id: p.beforeId, date: 0 } : p.before ? { id: 0, date: p.before } : undefined;
      let done = false;
      while (!done && out.length < p.limit) {
        const page = await tg.getHistory(p.chat, { limit: Math.min(100, p.limit - out.length), offset });
        if (!page.length) break;
        for (const m of page) {
          if (p.after && m.date.getTime() / 1000 <= p.after) { done = true; break; }
          out.push(msgRow(m));
        }
        if (!page.next) break;
        offset = page.next;
      }
      return out.reverse();
    });
  }

  /** Telegram's own search: inside one chat, or across all of them. Newest first. */
  async search(p: { query: string; chat?: number; since?: number; until?: number; limit: number }): Promise<MsgRow[]> {
    return this.use(async (tg) => {
      const minDate = p.since ? new Date(p.since * 1000) : undefined;
      const maxDate = p.until ? new Date(p.until * 1000) : undefined;
      const page = p.chat != null
        ? await tg.searchMessages({ query: p.query, chatId: p.chat, limit: p.limit, minDate, maxDate })
        : await tg.searchGlobal({ query: p.query, limit: p.limit, minDate, maxDate });
      return page.map(msgRow);
    });
  }

  // ---------- owner-password throttle ----------
  // Kept here because this object is the one strongly consistent place the deployment has (KV is eventually consistent).

  /**
   * Decide whether a password attempt may proceed, and if so count it as a failure until loginSucceeded() says otherwise.
   * Counting before the password is checked means a burst of parallel guesses cannot all slip past the limit.
   * Per source IP: 5 failures per 15 minutes. Deployment-wide: after 30 failures in 15 minutes attempts are paced 30 s
   * apart, which slows a distributed guesser to a crawl. The trade-off: while such an attack runs, the owner's NEW
   * sign-ins compete with it for that one slot and may be delayed. Already-approved MCP clients keep working. Rotating
   * IPv6 addresses can also get around the per-IP cap, so the password's length is still the real protection.
   */
  loginBegin(ip: string): { ok: true } | { ok: false; retryAfter: number } {
    const now = Date.now();
    const window = now - 15 * 60_000;
    this.sql.exec('DELETE FROM login_attempts WHERE ts < ?', now - 24 * 3600_000);
    const mine = this.sql.exec('SELECT ts FROM login_attempts WHERE ip = ? AND ts > ? ORDER BY ts DESC LIMIT 5', ip, window).toArray();
    if (mine.length >= 5) return { ok: false, retryAfter: Math.max(1, Math.ceil((Number(mine[4].ts) + 15 * 60_000 - now) / 1000)) };
    const all = this.sql.exec('SELECT COUNT(*) AS n, MAX(ts) AS last FROM login_attempts WHERE ts > ?', window).one();
    if (Number(all.n) >= 30 && Number(all.last) + 30_000 > now) return { ok: false, retryAfter: Math.ceil((Number(all.last) + 30_000 - now) / 1000) };
    this.sql.exec('INSERT INTO login_attempts (ts, ip, ok) VALUES (?, ?, 0)', now, ip);
    return { ok: true };
  }

  loginSucceeded(ip: string) {
    this.sql.exec('DELETE FROM login_attempts WHERE ip = ?', ip);
  }

  async ping(): Promise<{ id: number; name: string }> {
    return this.use(async (tg) => {
      const u = await tg.getMe();
      return { id: u.id, name: u.displayName };
    });
  }
}
