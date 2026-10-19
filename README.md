# telegram-mcp

Let your AI agent read your Telegram.

A small server that runs in your own Cloudflare account, signs in as **you** (a normal Telegram login, like Telegram Desktop), and lets any MCP client (Claude Code, Claude Desktop, anything that speaks MCP) list, read and search your chats. It is **read-only**: nothing in it can send, edit or delete a message.

Ask your agent things like:

- "What did Dana say about the flights?"
- "Search all my chats for the invoice number."
- "Summarize what I missed in the family group today."

> **Status: pre-release.** The plumbing is tested (see [Status](#status)); the Telegram login and the read tools have **not yet been run against a real account**. Try it on a spare account first.

## How it works

Telegram keeps your whole history on its servers, so, unlike a WhatsApp linked device, there is nothing to sync or mirror. Every tool call is a live request to Telegram through [mtcute](https://mtcute.dev) (an MTProto client) running inside a Durable Object. The only thing stored is the Telegram login itself, in that object's SQLite. The connection is opened on demand and closed again after ~30 s idle.

No computer of yours needs to stay on: it is all Cloudflare.

## Set it up

You need a Cloudflare account, Node 22.18+, and the Telegram app on your phone.

**1. Get Telegram API credentials.** Log in at <https://my.telegram.org>, open *API development tools* and create an app. Keep the `api_id` and `api_hash` private.

**2. Deploy.**

```sh
git clone https://github.com/sigman78/telegram-mcp
cd telegram-mcp
npm install

# A place for the sign-in tokens. Paste the id it prints into wrangler.jsonc.
npx wrangler kv namespace create OAUTH_KV

npx wrangler secret put TG_API_ID
npx wrangler secret put TG_API_HASH
npx wrangler secret put OWNER_PASSWORD     # 12+ characters. Make it long.

npm run deploy
```

Wrangler prints your URL, e.g. `https://telegram-mcp.your-name.workers.dev`. To keep your own KV id or domain out of git, put them in `wrangler.local.jsonc` (git-ignored) and deploy with `npm run deploy:local`.

**3. Link your account.** Open `<your-url>/setup`, enter the password, and scan the QR code in Telegram (*Settings > Devices > Link Desktop Device*). If the account has two-step verification, the page asks for that password too.

**4. Connect your agent.**

```sh
claude mcp add --transport http telegram https://your-url/mcp
```

Then type `/mcp` and sign in with the password. Other clients: point them at the same `/mcp` URL.

## Tools

| Tool | What it does |
| --- | --- |
| `list_chats` | Chats, most recent first, with unread counts and the latest message. Filter by name, @username or id. Looks through the ~500 most recent chats. |
| `get_messages` | Read one chat, oldest first. Page back without gaps with `before_id` (the lowest `#id` shown); `before` / `after` filter by time. |
| `search_messages` | Telegram's own search, across all chats or inside one. |
| `link_status` | Linked as whom, and whether the session is still valid. |
| `relink` | Log out of Telegram (the device disappears from your phone's list) so you can link again. |

Times are printed with seconds and a UTC offset (`2026-10-19 18:05:44 +02:00`), and the same string can be passed back in. Dates given without an offset are read in your `TIMEZONE`.

## Security and privacy

Your Telegram session is a key to your whole account. Treat a deployment like a password manager.

- It lives only in the Durable Object. **No messages are stored anywhere**; every read goes straight to Telegram.
- `/mcp` needs an OAuth token, issued only after the owner types the password in the browser that started the approval. The approval screen names the app and shows where it will be redirected.
- Password guesses are throttled: 5 failures per IP per 15 minutes, and after 30 failures deployment-wide attempts are spaced 30 s apart. That slows a distributed guesser but does not stop one, and during an attack your own new sign-ins can be delayed (already-approved clients keep working). **The strength of the password is the real protection.**
- Client registration is open, as the MCP spec expects. Read the approval screen before typing the password.
- You can end access any time: remove the device in Telegram (*Settings > Devices*), call `relink`, or delete the Worker.

More in [SECURITY.md](SECURITY.md).

## Things to know

- **Unofficial use of Telegram's API.** It uses your own `api_id`, like any third-party client. Telegram can still restrict accounts that behave like scrapers, so keep call volume modest. Heavy use triggers `FLOOD_WAIT`; tool results say so.
- **Not covered:** secret chats (they live on one device only), media contents (shown as labels such as `[photo]` or `[voice note 12s]`), and any sending.
- **One person per deployment.** Each deployment holds a live login to one account.
- **Cost.** The bundle is ~420 KiB gzipped and does no heavy work, so the Workers free plan may be enough. That has not been tried under real use.

## Configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `TG_API_ID`, `TG_API_HASH` | secrets | From my.telegram.org. |
| `OWNER_PASSWORD` | secret | Protects setup and MCP approval. 12+ characters. |
| `TIMEZONE` | var, optional | IANA zone used to print and parse times (e.g. `Europe/Berlin`). Defaults to `UTC`. |
| `OAUTH_KV` | KV binding | Token store for the OAuth provider and pending sign-ins. |
| `TG` | Durable Object binding | The Telegram session. |

## Architecture

```
MCP client --OAuth--> Worker (src/index.ts) --/mcp--> src/mcp.ts (tools)
                          |                                |
                          +-- /setup, /login, /link/* -----+--RPC--> TelegramSession (Durable Object)
                                                                      |- SQLite: mtcute session (src/storage.ts)
                                                                      '- mtcute client over WebSocket,
                                                                         opened on demand, closed after ~30 s idle
```

| File | Job |
| --- | --- |
| `src/index.ts` | Routes: OAuth provider wiring, sign-in, setup page, `/link/*`. |
| `src/auth.ts` | Owner password, bearer tokens, browser session, approval-to-browser binding. |
| `src/telegram-do.ts` | The Durable Object: QR login, 2FA hand-off, live reads, idle lifecycle, login throttle. |
| `src/storage.ts` | mtcute's storage interfaces on Durable Object SQLite. |
| `src/mcp.ts` | The MCP tools. One fresh `McpServer` per request. |
| `src/time.ts` | Printing and parsing times with offsets and a configured zone. |
| `src/pages.ts` | All HTML (landing, sign-in, approval, QR / 2FA setup page). |
| `test/` | Unit tests (`node:test`). |

## Development

```sh
npm install
npm run typecheck
npm test
```

To run locally, create `.dev.vars` (git-ignored) with `OWNER_PASSWORD`, `TG_API_ID` and `TG_API_HASH`, then `npm run dev`. A local run uses its own empty Durable Object storage. Linking a real account from local dev creates a second Telegram session for it.

### Notes for contributors

These each cost time to find; read them before changing the Telegram parts.

1. **Wasm.** mtcute does its crypto in wasm, and workerd cannot compile wasm from bytes at runtime. `wrangler.jsonc` has a `CompiledWasm` rule, `telegram-do.ts` imports `@mtcute/wasm/mtcute.wasm` as a module and passes it to `WebCryptoProvider({ wasmInput })`. The import is outside `src/`, hence the `@ts-expect-error`.
2. **`updates: false` goes on the base client.** `new TelegramClient({ disableUpdates: true })` only disables the wrapper; the base client still builds an update manager unless it gets `updates: false`. Do **not** pass `disableUpdates` to the base client instead: per mtcute's source it also suppresses raw updates, and QR login relies on `updateLoginToken` arriving through `onServerUpdate` (this part is not yet confirmed with a real scan).
3. **Idle close must not interrupt a read.** `use()` counts in-flight calls and the alarm only closes the client at zero. Idle time is counted from when the last call *ended*.
4. **Linking outlives the HTTP request.** `startLink` sets an alarm and `alarm()` awaits the login promise; an in-flight alarm handler is what keeps the object alive while the user finds their phone. The setup page restarts linking if the server reports `idle` (e.g. after a restart).
5. **Chat ids are mtcute "marked" ids** (negative for groups, `-100…` for channels). Lookups by name use a 2-minute cache of the 500 most recent dialogs. An explicit `@username` never falls back to title matching.
6. **Pagination.** `getHistory`'s `offset.date` is Unix *seconds*; `searchMessages` / `searchGlobal` treat plain numbers as *milliseconds*, so `search()` passes `Date` objects. `before_id` is the exact cursor; time filters are only second-accurate.
7. **Pin mtcute exactly.** The API moves between minor versions.
8. **Auth loss.** If Telegram says the session is gone (`AUTH_KEY_UNREGISTERED` and friends), the object forgets the login and tools report "not linked" with the setup URL.

## Status

Verified: typecheck and unit tests; mtcute connects to Telegram and makes calls from a deployed Durable Object (and under `wrangler dev`); the stored login survives a client restart; OAuth registration, consent, sign-in, token exchange and MCP calls end to end; browser-bound approvals; password throttling including parallel guesses; idle close not interrupting a long read; the setup page script against scripted states; rejection of a bad session.

**Not yet verified with a real account:** QR login, the 2FA step, the read tools against real chats (including `before_id` paging and `@username` lookup), and that scan notices still arrive with the update stream off. If the setup page stays on the QR code for up to ~30 s after a scan and never shows "Scanned", that last point is the cause.

### Roadmap

- First real-account run and fixes from it.
- A local stdio variant sharing the same Telegram code (needs the read logic pulled out of the Durable Object class into a module that takes a `TelegramClient`).
- Optional redirect-URI allowlist for MCP clients.
- Automated integration tests for the OAuth and throttling flows (currently run by hand against `wrangler dev`).

## Related projects

- [finereli/whatsapp-mcp](https://github.com/finereli/whatsapp-mcp): the WhatsApp original this is modelled on (MIT). Its OAuth and `/mcp` structure is reused here.
- Other Telegram MCP servers exist, mostly local and mostly able to send; for example [chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp) and [freQuensy23-coder/telegram-mcp-serverless](https://github.com/freQuensy23-coder/telegram-mcp-serverless) (mtcute on Workers). This one differs in being read-only, OAuth-gated for MCP clients, and linked from a web page by QR code.

## License

[MIT](LICENSE). Portions adapted from finereli/whatsapp-mcp (MIT).
