# Security

This server holds a **Telegram session**, which is a full-access credential for one Telegram account. Treat a deployment like a password manager: single owner, minimal exposure.

## Model

- **One owner.** One deployment is one Telegram account and one owner. There is no multi-user mode.
- **Where secrets live.** `TG_API_ID`, `TG_API_HASH` and `OWNER_PASSWORD` are Cloudflare Worker secrets. The Telegram session (auth key and peer cache) is stored in the Durable Object's SQLite and never leaves it. No messages are stored.
- **Read-only.** No tool sends, edits or deletes anything on Telegram. Adding such a tool would change this security model; think hard before doing it.
- **Access control.** `/mcp` requires an OAuth access token. Tokens are issued only after the owner enters `OWNER_PASSWORD` in the browser that started the approval. The approval screen shows which app is asking and where it will be redirected. Password attempts are throttled (see the README for the exact policy and its limits).
- **Ending access.** Remove the device in Telegram under Settings > Devices (this kills the session at the source), or call the `relink` tool, or delete the Worker.

## Known limits

- MCP client registration is open (dynamic client registration), as the MCP specification expects. Anyone can register a client and ask for approval; the owner must read the approval screen. A fake display name is possible; the redirect host is shown next to it.
- The password throttle slows guessing but cannot stop a distributed attacker. Use a long, random `OWNER_PASSWORD`.
- Telegram may restrict accounts whose API use looks like scraping. Keep call volume modest.

## Reporting a vulnerability

This is a private project for now. If you have access and find a problem, open a private advisory under the repository's **Security** tab, or contact the owner directly. Please do not put exploit details in public issues.
