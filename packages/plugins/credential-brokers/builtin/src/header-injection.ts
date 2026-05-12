/**
 * Pure helpers for the proxy listener's header-rewrite step:
 *   - strip any placeholder value the agent leaked back to us
 *   - inject the per-host Authorization header from the bearer cache
 *
 * Separated from the TLS / socket pipework so the rewrite logic
 * unit-tests without spinning up a real proxy.
 */

import type { HostRule } from "./session-store.js";

export interface HeaderRewriteInput {
  /** Inbound request headers, as Node's `req.headers` shape (lowercased keys). */
  headers: Record<string, string | string[] | undefined>;
  /** Host rule for the upstream target, if matched. */
  rule: HostRule | undefined;
  /** Bearer cache lookup for the matched rule's connection. */
  bearer: string | undefined;
  /** All known placeholder strings on this session; any match is stripped. */
  knownPlaceholders: ReadonlyArray<string>;
}

export interface HeaderRewriteResult {
  headers: Record<string, string | string[] | undefined>;
  /** Did we inject the real Authorization for this request? */
  injected: boolean;
  /** Did we strip a value that contained a known placeholder? */
  strippedPlaceholder: boolean;
}

/** Returns true if any of the placeholders is a substring of value. */
function containsPlaceholder(
  value: string,
  placeholders: ReadonlyArray<string>,
): boolean {
  for (const p of placeholders) if (value.includes(p)) return true;
  return false;
}

/** Token-format substitution that tolerates either `{value}` or no placeholder. */
function applyFormat(format: string, value: string): string {
  return format.includes("{value}") ? format.replace("{value}", value) : value;
}

export function rewriteHeadersForUpstream(
  input: HeaderRewriteInput,
): HeaderRewriteResult {
  const out: Record<string, string | string[] | undefined> = {};
  let strippedPlaceholder = false;

  for (const [key, value] of Object.entries(input.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const filtered = value.filter((v) => {
        if (typeof v !== "string") return true;
        if (containsPlaceholder(v, input.knownPlaceholders)) {
          strippedPlaceholder = true;
          return false;
        }
        return true;
      });
      if (filtered.length > 0) out[key] = filtered;
      continue;
    }
    if (
      typeof value === "string" &&
      containsPlaceholder(value, input.knownPlaceholders)
    ) {
      strippedPlaceholder = true;
      continue;
    }
    out[key] = value;
  }

  let injected = false;
  if (input.rule && input.bearer) {
    const headerKey = input.rule.header.toLowerCase();
    out[headerKey] = applyFormat(input.rule.format, input.bearer);
    injected = true;
  }

  return { headers: out, injected, strippedPlaceholder };
}
