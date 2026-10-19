import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { TelegramSession } from './telegram-do.js';

export interface Env {
  TG: DurableObjectNamespace<TelegramSession>;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** From my.telegram.org, "API development tools". Secrets. */
  TG_API_ID: string;
  TG_API_HASH: string;
  /** Password for the setup page and for approving MCP clients. 12+ characters. Secret. */
  OWNER_PASSWORD?: string;
  /** IANA zone used when printing message times. Defaults to UTC. */
  TIMEZONE?: string;
}
