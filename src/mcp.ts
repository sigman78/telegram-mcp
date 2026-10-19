/** The MCP surface: read-only tools over the owner's Telegram account. Every call goes live to Telegram. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { Env } from './env.js';
import { NotLinkedError, type TelegramSession } from './telegram-do.js';
import { formatTime, parseTime } from './time.js';

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) });

/** Search results are for skimming; a long post shouldn't flood the context. get_messages has the full text. */
const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}... [+${s.length - n} chars]` : s);

/** An unknown TIMEZONE would make every tool fail; fall back to UTC instead. */
function validZone(tz?: string): string {
  try {
    if (tz) new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The agent gave us something we cannot use (as opposed to Telegram failing). Reported as-is, not as a Telegram error. */
class BadInput extends Error {}

function buildServer(tg: DurableObjectStub<TelegramSession>, env: Env, origin: string) {
  const tz = validZone(env.TIMEZONE);
  const when = (ts: number) => formatTime(tz, ts);
  /** Dates the agent passes in. With no offset they are read in the server's timezone. */
  const epoch = (s?: string) => {
    try {
      return s ? parseTime(s, tz) : undefined;
    } catch (e: any) {
      throw new BadInput(e.message);
    }
  };

  const server = new McpServer(
    { name: 'telegram-mcp', version: '0.1.0' },
    {
      instructions:
        `Read-only access to the owner's Telegram account (their own account, not a bot): direct chats, groups and channels. It cannot send, edit or delete anything. ` +
        `Times are ${tz}. Every call goes live to Telegram, so results are always current. ` +
        `Use list_chats to find a chat, get_messages to read it, search_messages to find things (in one chat or across all of them).`,
    },
  );

  /** Run a tool body; turn "not linked" and Telegram errors into messages the agent can act on. */
  const guard = async (body: () => Promise<ReturnType<typeof text>>) => {
    try {
      return await body();
    } catch (e: any) {
      if (e instanceof BadInput) return text(e.message, true);
      if (e instanceof NotLinkedError || /NotLinkedError|not linked/i.test(String(e?.message))) {
        return text(`Telegram is not linked. The owner needs to open ${origin}/setup and scan the QR code. (${e?.message})`, true);
      }
      const msg = String(e?.text ?? e?.message ?? e);
      if (/FLOOD_WAIT/.test(msg)) return text(`Telegram is rate limiting this account (${msg}). Wait a bit and try again, and ask for fewer chats or messages.`, true);
      return text(`Telegram error: ${msg}`, true);
    }
  };

  const pickChat = async (chat: string) => {
    const matches = await tg.resolveChat(chat);
    if (!matches.length) return { error: text(`No chat matches "${chat}". Try list_chats with part of the name.`) };
    if (matches.length > 1) {
      return { error: text(`"${chat}" matches several chats, pick one by id:\n${matches.slice(0, 15).map((m) => `${m.name} | ${m.id}`).join('\n')}`) };
    }
    return { chat: matches[0] };
  };

  server.registerTool(
    'list_chats',
    {
      description:
        'List chats (people, groups, channels, bots), most recently active first, with unread counts and the latest message. ' +
        'Optionally filter by a name, @username or id fragment. Only the most recent ~500 chats are searched.',
      inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(100).default(30) },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit }) =>
      guard(async () => {
        const rows = await tg.chats(query, limit);
        if (!rows.length) return text(`No chats found${query ? ` matching "${query}"` : ''}.`);
        return text(
          rows
            .map((r) => `${r.name} [${r.type}]${r.username ? ` @${r.username}` : ''} | ${r.unread ? `${r.unread} unread | ` : ''}last ${r.lastTs ? when(r.lastTs) : 'never'}: ${r.lastText} | id ${r.id}`)
            .join('\n'),
        );
      }),
  );

  server.registerTool(
    'get_messages',
    {
      description:
        'Read messages from one chat, oldest first. `chat` is a name, @username or id from list_chats. ' +
        'By default returns the most recent messages. To page back without gaps, pass `before_id` = the lowest #id you were shown. ' +
        '`before` / `after` limit by time instead (with `after` you still get the most recent messages inside the window). ' +
        'Times include seconds and a UTC offset; dates without an offset are read in the server timezone.',
      inputSchema: {
        chat: z.string(),
        limit: z.number().int().min(1).max(500).default(50),
        before_id: z.number().int().positive().optional().describe('Message id; only messages older than this (exact paging)'),
        before: z.string().optional().describe('ISO date/time; only messages before this'),
        after: z.string().optional().describe('ISO date/time; only messages after this'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ chat, limit, before_id, before, after }) =>
      guard(async () => {
        const [beforeTs, afterTs] = [epoch(before), epoch(after)]; // check input first: no Telegram call for a bad date
        const picked = await pickChat(chat);
        if (picked.error) return picked.error;
        const rows = await tg.messages({ chat: picked.chat!.id, limit, beforeId: before_id, before: beforeTs, after: afterTs });
        const head = `# ${picked.chat!.name} (${rows.length} messages)\n`;
        return text(head + rows.map((r) => `#${r.id} [${when(r.ts)}] ${r.from}${r.replyTo ? ` (reply to #${r.replyTo})` : ''}: ${r.text}`).join('\n'));
      }),
  );

  server.registerTool(
    'search_messages',
    {
      description:
        "Full-text search using Telegram's own search, newest matches first. Across all chats by default, or inside one chat. " +
        'Telegram matches words, not exact phrases, so try a distinctive word.',
      inputSchema: {
        query: z.string(),
        chat: z.string().optional().describe('Restrict to one chat (name, @username or id)'),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, chat, since, until, limit }) =>
      guard(async () => {
        const [sinceTs, untilTs] = [epoch(since), epoch(until)];
        let chatId: number | undefined;
        if (chat) {
          const picked = await pickChat(chat);
          if (picked.error) return picked.error;
          chatId = picked.chat!.id;
        }
        const rows = await tg.search({ query, chat: chatId, since: sinceTs, until: untilTs, limit });
        if (!rows.length) return text('No matches.');
        return text(rows.map((r) => `[${when(r.ts)}] ${r.chat} | #${r.id} ${r.from}: ${clip(r.text)}`).join('\n'));
      }),
  );

  server.registerTool(
    'link_status',
    {
      description: 'Is Telegram linked, and as whom. Use this first if anything looks wrong.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      guard(async () => {
        const s = await tg.linkStatus();
        if (!s.configured) return text('This deployment has no TG_API_ID / TG_API_HASH set, so it cannot talk to Telegram.');
        if (!s.linked) return text(`Not linked. The owner needs to open ${origin}/setup and scan the QR code with Telegram (Settings > Devices > Link Desktop Device).`);
        const live = await tg.ping();
        return text(`Linked as ${live.name} (id ${live.id}). Reads are live from Telegram. To link a different account or fix a broken session, call relink.`);
      }),
  );

  server.registerTool(
    'relink',
    {
      description:
        'Log this server out of Telegram (the device disappears from the phone\'s list) so the account can be linked again. ' +
        'The owner must then open the returned URL and scan a new QR code, which an agent cannot do for them. ' +
        'Use when link_status says not linked, or the session is broken, or the owner asks to relink.',
      inputSchema: {},
      annotations: { destructiveHint: true },
    },
    () =>
      guard(async () => {
        const r = await tg.logout();
        return text(
          `Unlinked${r.remote ? '' : ' locally (Telegram could not be reached, so remove the device by hand in Telegram > Settings > Devices)'}. ` +
            `Ask the owner to open ${origin}/setup and scan the QR code.`,
        );
      }),
  );

  return server;
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const tg = env.TG.get(env.TG.idFromName('owner'));
  const server = buildServer(tg, env, new URL(request.url).origin);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
