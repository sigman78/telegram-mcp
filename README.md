# telegram-mcp

Let your AI agent read your Telegram.

A small server that runs in your own Cloudflare account, signs in as **you** (a normal Telegram login, like Telegram Desktop), and lets any MCP client (Claude Code, Claude Desktop, anything that speaks MCP) list, read and search your chats. It is **read-only**: nothing in it can send, edit or delete a message.

Ask your agent things like:

- "What did Dana say about the flights?"
- "Search all my chats for the invoice number."
- "Summarize what I missed in the family group today."

> **Status: pre-release.** The plumbing is tested (see [Status](#status)); the Telegram login and the read tools have **not yet been run against a real account**. Try it on a spare account first.

## How it works

Telegram keeps your whole history on its servers, so there is nothing to sync or mirror. Every tool call is a live request to Telegram through [mtcute](https://mtcute.dev) (an MTProto client) running inside a Durable Object. The only thing stored is the Telegram login itself, in that object's SQLite. No computer of yours needs to stay on.

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

Wrangler prints your URL, e.g. `https://telegram-mcp.your-name.workers.dev`. To keep your own KV id out of git, put it in `wrangler.local.jsonc` (git-ignored) and deploy with `npm run deploy:local`. Times are shown in UTC unless you set a `TIMEZONE` var (an IANA zone such as `Europe/Berlin`) in the config.

**3. Link your account.** Open `<your-url>/setup`, enter the password, and scan the QR code in Telegram (*Settings > Devices > Link Desktop Device*). If the account has two-step verification, the page asks for that password too.

**4. Connect your agent.**

```sh
claude mcp add --transport http telegram https://your-url/mcp
```

Then type `/mcp` and sign in with the password. Other clients: point them at the same `/mcp` URL.

## Tools

| Tool | What it does |
| --- | --- |
| `list_chats` | Chats, most recent first, with unread counts and the latest message. Filter by name, @username or id. |
| `get_messages` | Read one chat, oldest first. Page back with `before_id`; `before` / `after` filter by time. |
| `search_messages` | Telegram's own search, across all chats or inside one. |
| `link_status` | Linked as whom, and whether the session is still valid. |
| `relink` | Log out of Telegram so you can link again. |

## Security

Your Telegram session is a key to your whole account. Treat a deployment like a password manager.

- The session lives only in the Durable Object. **No messages are stored anywhere.**
- `/mcp` needs an OAuth token, issued only after you type the password in the browser that started the approval. The approval screen names the app and shows where it will be redirected. Client registration is open, so read it.
- Password guesses are throttled, but that slows a guesser and does not stop one. **The strength of the password is the real protection.**
- Browser sessions last 14 days and cannot be revoked individually; changing `OWNER_PASSWORD` signs everything out.
- Any approved client can call `relink`.
- Client registration writes to KV and needs no login, so it is capped at 10 per minute per IP (the `ratelimits` binding in `wrangler.jsonc`). The cap is approximate, so a determined flood could still use up the free KV write quota and lock you out until it resets.
- This uses Telegram's API unofficially, with your own `api_id`. Keep call volume modest; heavy use triggers `FLOOD_WAIT`.
- To end access: remove the device in Telegram (*Settings > Devices*), call `relink`, or delete the Worker.

More in [SECURITY.md](SECURITY.md).

## Status

Verified: typecheck and unit tests; mtcute connects to Telegram and makes calls from a deployed Durable Object; the stored login survives a client restart; OAuth registration, consent, sign-in, token exchange and MCP calls end to end; browser-bound approvals; password throttling; idle close not interrupting a long read.

**Not yet verified with a real account:** QR login, the 2FA step, the read tools against real chats, and that scan notices still arrive with the update stream off. If the setup page stays on the QR code for up to ~30 s after a scan and never shows "Scanned", that last point is the cause.

## Related projects

Other Telegram MCP servers exist, mostly local and mostly able to send; for example [chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp) and [freQuensy23-coder/telegram-mcp-serverless](https://github.com/freQuensy23-coder/telegram-mcp-serverless) (mtcute on Workers). This one differs in being read-only, OAuth-gated for MCP clients, and linked from a web page by QR code.

## License

[MIT](LICENSE).
