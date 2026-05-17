/**
 * Phase 4A-S4 (LET-366): pre-egress redaction for managed sandbox providers.
 *
 * The managed provider contract requires the data-plane caller (the
 * sandbox-provider-runtime layer) to redact any string handed to the
 * provider transport against a per-run registry of resolved secrets before
 * the transport is asked to make any outbound call. The provider boundary
 * is `redactionBoundary: "before-provider"` — the transport itself only
 * appends auth headers AFTER redaction is applied so the registered
 * secret value cannot be echoed back into a command line, env value,
 * stdin payload, request body, or caller-supplied header that is captured
 * for audit, logs, or test fixtures.
 *
 * This module intentionally has no provider awareness — it is a plain
 * string-replacement registry that the lease lifecycle threads through.
 */

const REDACTION_PLACEHOLDER = "[REDACTED]" as const;

/**
 * Per-run registry of resolved secret values that must never reach the
 * provider transport in their raw form. Callers register the resolved
 * value (e.g. the resolved E2B API key) before constructing the live
 * transport, then pass `redact` to anything that builds outbound payloads.
 */
export class PreProviderRedactionRegistry {
  private readonly secrets = new Set<string>();

  /** Register a resolved secret value. Short values (< 4 chars) are ignored
   *  to avoid replacing benign tokens that happen to match a stored prefix. */
  register(value: string | null | undefined): void {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length < 4) return;
    this.secrets.add(trimmed);
  }

  size(): number {
    return this.secrets.size;
  }

  /** Returns the input with every registered secret value replaced by
   *  the placeholder. Longest-first ordering prevents a shorter prefix
   *  from masking a longer overlapping secret. */
  redact(input: string): string {
    if (typeof input !== "string" || input.length === 0 || this.secrets.size === 0) {
      return input;
    }
    const ordered = [...this.secrets].sort((a, b) => b.length - a.length);
    let out = input;
    for (const secret of ordered) {
      if (!secret) continue;
      out = splitReplaceAll(out, secret, REDACTION_PLACEHOLDER);
    }
    return out;
  }
}

function splitReplaceAll(input: string, needle: string, replacement: string): string {
  if (!needle) return input;
  return input.split(needle).join(replacement);
}

/**
 * Redact a single string against the supplied registry. Convenience
 * wrapper so call sites can use a free function form.
 */
export function redactBeforeProvider(
  input: string,
  registry: PreProviderRedactionRegistry,
): string {
  return registry.redact(input);
}

/**
 * Redact a record of strings (env map, header map). Keys are kept as-is.
 */
export function redactRecordBeforeProvider(
  input: Record<string, string> | undefined,
  registry: PreProviderRedactionRegistry,
): Record<string, string> | undefined {
  if (!input) return input;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = registry.redact(value);
  }
  return out;
}

/**
 * Redact an array of command arguments.
 */
export function redactArrayBeforeProvider(
  input: string[] | undefined,
  registry: PreProviderRedactionRegistry,
): string[] | undefined {
  if (!input) return input;
  return input.map((value) => registry.redact(value));
}

export const __testing = {
  REDACTION_PLACEHOLDER,
};
