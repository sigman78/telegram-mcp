/**
 * mtcute storage on a Durable Object's SQLite. Holds the auth key (the login), the peer cache (access hashes
 * mtcute needs to address chats) and a few key/value rows. It stores no messages: Telegram keeps those.
 */
import type { IKeyValueRepository, IAuthKeysRepository, IPeersRepository, IReferenceMessagesRepository, ITelegramStorageProvider } from '@mtcute/web';

type Sql = SqlStorage;
const bytes = (v: unknown) => (v == null ? null : new Uint8Array(v as ArrayBuffer));

export function initStorageSchema(sql: Sql) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS tg_kv (key TEXT PRIMARY KEY, value BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS tg_auth_keys (dc INTEGER PRIMARY KEY, key BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS tg_temp_keys (dc INTEGER NOT NULL, idx INTEGER NOT NULL, key BLOB NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY (dc, idx));
    CREATE TABLE IF NOT EXISTS tg_peers (
      id INTEGER PRIMARY KEY, access_hash TEXT NOT NULL, is_min INTEGER NOT NULL,
      usernames TEXT NOT NULL, updated INTEGER NOT NULL, phone TEXT, complete BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tg_peers_phone ON tg_peers (phone);
    CREATE TABLE IF NOT EXISTS tg_ref_messages (peer_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, msg_id INTEGER NOT NULL, PRIMARY KEY (peer_id, chat_id, msg_id));
  `);
}

class Kv implements IKeyValueRepository {
  constructor(private sql: Sql) {}
  set = (key: string, value: Uint8Array) => void this.sql.exec('INSERT OR REPLACE INTO tg_kv (key, value) VALUES (?, ?)', key, value);
  get = (key: string) => bytes(this.sql.exec('SELECT value FROM tg_kv WHERE key = ?', key).toArray()[0]?.value);
  delete = (key: string) => void this.sql.exec('DELETE FROM tg_kv WHERE key = ?', key);
  deleteAll = () => void this.sql.exec('DELETE FROM tg_kv');
}

class AuthKeys implements IAuthKeysRepository {
  constructor(private sql: Sql) {}
  set = (dc: number, key: Uint8Array | null) => {
    if (key) this.sql.exec('INSERT OR REPLACE INTO tg_auth_keys (dc, key) VALUES (?, ?)', dc, key);
    else this.sql.exec('DELETE FROM tg_auth_keys WHERE dc = ?', dc);
  };
  get = (dc: number) => bytes(this.sql.exec('SELECT key FROM tg_auth_keys WHERE dc = ?', dc).toArray()[0]?.key);
  setTemp = (dc: number, idx: number, key: Uint8Array | null, expires: number) => {
    if (key) this.sql.exec('INSERT OR REPLACE INTO tg_temp_keys (dc, idx, key, expires) VALUES (?, ?, ?, ?)', dc, idx, key, expires);
    else this.sql.exec('DELETE FROM tg_temp_keys WHERE dc = ? AND idx = ?', dc, idx);
  };
  getTemp = (dc: number, idx: number, now: number) =>
    bytes(this.sql.exec('SELECT key FROM tg_temp_keys WHERE dc = ? AND idx = ? AND expires > ?', dc, idx, now).toArray()[0]?.key);
  deleteByDc = (dc: number) => {
    this.sql.exec('DELETE FROM tg_auth_keys WHERE dc = ?', dc);
    this.sql.exec('DELETE FROM tg_temp_keys WHERE dc = ?', dc);
  };
  deleteAll = () => {
    this.sql.exec('DELETE FROM tg_auth_keys');
    this.sql.exec('DELETE FROM tg_temp_keys');
  };
}

type PeerInfo = IPeersRepository.PeerInfo;

class Peers implements IPeersRepository {
  constructor(private sql: Sql) {}
  // usernames are stored as " name1 name2 " (lowercase) so a whole name can be found with instr(); '_' would be a LIKE wildcard
  store = (p: PeerInfo) =>
    void this.sql.exec(
      'INSERT OR REPLACE INTO tg_peers (id, access_hash, is_min, usernames, updated, phone, complete) VALUES (?, ?, ?, ?, ?, ?, ?)',
      p.id, p.accessHash, p.isMin ? 1 : 0, ` ${p.usernames.map((u) => u.toLowerCase()).join(' ')} `, p.updated, p.phone ?? null, p.complete,
    );
  private row = (r: Record<string, SqlStorageValue> | undefined): PeerInfo | null =>
    r
      ? {
          id: Number(r.id),
          accessHash: String(r.access_hash),
          isMin: r.is_min === 1,
          usernames: String(r.usernames).trim().split(' ').filter(Boolean),
          updated: Number(r.updated),
          phone: r.phone == null ? undefined : String(r.phone),
          complete: bytes(r.complete)!,
        }
      : null;
  getById = (id: number) => this.row(this.sql.exec('SELECT * FROM tg_peers WHERE id = ?', id).toArray()[0]);
  getByUsername = (username: string) =>
    this.row(this.sql.exec('SELECT * FROM tg_peers WHERE is_min = 0 AND instr(usernames, ?) > 0', ` ${username.toLowerCase()} `).toArray()[0]);
  getByPhone = (phone: string) => this.row(this.sql.exec('SELECT * FROM tg_peers WHERE is_min = 0 AND phone = ?', phone).toArray()[0]);
  deleteAll = () => void this.sql.exec('DELETE FROM tg_peers');
}

class RefMessages implements IReferenceMessagesRepository {
  constructor(private sql: Sql) {}
  store = (peerId: number, chatId: number, msgId: number) =>
    void this.sql.exec('INSERT OR REPLACE INTO tg_ref_messages (peer_id, chat_id, msg_id) VALUES (?, ?, ?)', peerId, chatId, msgId);
  getByPeer = (peerId: number): [number, number] | null => {
    const r = this.sql.exec('SELECT chat_id, msg_id FROM tg_ref_messages WHERE peer_id = ? ORDER BY msg_id DESC LIMIT 1', peerId).toArray()[0];
    return r ? [Number(r.chat_id), Number(r.msg_id)] : null;
  };
  delete = (chatId: number, msgIds: number[]) => {
    for (const id of msgIds) this.sql.exec('DELETE FROM tg_ref_messages WHERE chat_id = ? AND msg_id = ?', chatId, id);
  };
  deleteByPeer = (peerId: number) => void this.sql.exec('DELETE FROM tg_ref_messages WHERE peer_id = ?', peerId);
  deleteAll = () => void this.sql.exec('DELETE FROM tg_ref_messages');
}

/** Everything is written immediately, so the driver has nothing to load or flush. */
export class DoSqliteStorage implements ITelegramStorageProvider {
  readonly driver = {};
  readonly kv: Kv;
  readonly authKeys: AuthKeys;
  readonly peers: Peers;
  readonly refMessages: RefMessages;
  constructor(private sql: Sql) {
    initStorageSchema(sql);
    this.kv = new Kv(sql);
    this.authKeys = new AuthKeys(sql);
    this.peers = new Peers(sql);
    this.refMessages = new RefMessages(sql);
  }
  /** Forget the login and everything cached about peers. */
  wipe() {
    for (const t of ['tg_kv', 'tg_auth_keys', 'tg_temp_keys', 'tg_peers', 'tg_ref_messages']) this.sql.exec(`DELETE FROM ${t}`);
  }
}
