import { createHash } from "node:crypto";

/**
 * Postgres LISTEN channel name for a given company.
 *
 * Postgres identifiers are limited to 63 bytes (NAMEDATALEN-1) and channels
 * passed to LISTEN/NOTIFY are treated as identifiers. Paperclip company ids
 * are UUIDs or other operator-supplied strings that may contain characters
 * requiring quoting, so we derive a deterministic short hex hash and prefix
 * it. Receivers map back to companyId via a Map kept in the transport.
 */
export function pgChannelForCompany(companyId: string): string {
  if (companyId === "*") return "paperclip_live_evt_global";
  const hash = createHash("sha256").update(companyId).digest("hex").slice(0, 24);
  return `paperclip_live_evt_${hash}`;
}

/** Redis channel name for a given company. Redis tolerates arbitrary strings. */
export function redisChannelForCompany(companyId: string): string {
  if (companyId === "*") return "paperclip:live-events:global";
  return `paperclip:live-events:${companyId}`;
}
