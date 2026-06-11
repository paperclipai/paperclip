import { createHash } from "node:crypto";

/**
 * Postgres LISTEN channel name for a given company.
 *
 * Postgres identifiers are limited to 63 bytes (NAMEDATALEN-1) and channels
 * passed to LISTEN/NOTIFY are treated as identifiers. Paperclip company ids
 * are UUIDs or other operator-supplied strings that may contain characters
 * requiring quoting, so we derive a deterministic short hex hash and prefix
 * it. Receivers map back to companyId via a Map kept in the transport.
 *
 * Hashing here is purely an identifier-fit for Postgres's 63-byte channel-name
 * cap, NOT a security control. Tenant isolation comes from the WS upgrade
 * gate in `realtime/live-events-ws.ts` (`authorizeUpgrade` rejects
 * connections whose principal does not have membership in the requested
 * company), so the transport trusts the in-process `subscribe(companyId)`
 * call. SHA-256 truncated to 96 bits is collision-safe for any realistic
 * tenant count.
 */
export function pgChannelForCompany(companyId: string): string {
  if (companyId === "*") return "paperclip_live_evt_global";
  const hash = createHash("sha256").update(companyId).digest("hex").slice(0, 24);
  return `paperclip_live_evt_${hash}`;
}

/**
 * Redis channel name for a given company. Redis tolerates arbitrary strings;
 * this assumes companyId is a UUID. If company-creation ever permits glob
 * characters (`*`, `?`, `[`) in companyId, this channel naming needs
 * revisiting (those would interact with PSUBSCRIBE pattern matching).
 */
export function redisChannelForCompany(companyId: string): string {
  // "$global" cannot collide with a real company id: ids never start with
  // "$", whereas a company literally named "global" would otherwise share
  // the broadcast channel's name.
  if (companyId === "*") return "paperclip:live-events:$global";
  return `paperclip:live-events:${companyId}`;
}
