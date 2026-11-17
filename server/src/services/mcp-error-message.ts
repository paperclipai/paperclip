import { redactEventPayload, redactSensitiveText } from "../redaction.js";
import { redactSensitiveValueOccurrences } from "../middleware/redact-sensitive.js";
import { ToolContentValidationError, validateToolContent } from "./tool-content-guards.js";

/** Reuse the event redactor's credential names for headers and query keys.
 * MCP endpoints also commonly use the bare query name `key`. */
export function mcpErrorRequestSecrets(values: Record<string, string> | URLSearchParams): string[] {
  const entries = values instanceof URLSearchParams ? [...values] : Object.entries(values);
  return entries
    .filter(([key, value]) => (redactEventPayload({ [key]: value }) as Record<string, unknown>)[key] !== value
      || /^(key|session|mcp-session-id)$/i.test(key))
    .map(([, value]) => value);
}

/** Only the protocol's message is diagnostic text. Never reflect arbitrary data,
 * stacks, or the raw response. Redact before truncating so a boundary cannot
 * turn a credential into an unrecognizable, partially exposed value. */
export async function mcpErrorMessage(
  fallback: string,
  error: unknown,
  headers: Record<string, string>,
  sensitiveValues: readonly string[] = [],
  classifier?: Parameters<typeof validateToolContent>[0]["classifier"],
): Promise<string> {
  if (!error || typeof error !== "object" || Array.isArray(error)) return fallback;
  const { message } = error as Record<string, unknown>;
  if (typeof message !== "string" || !message.trim()) return fallback;
  // Remove bare authorization credentials as well as the full header.
  const values = [...sensitiveValues, ...mcpErrorRequestSecrets(headers),
    ...Object.entries(headers).filter(([key]) => /^(proxy-)?authorization$/i.test(key))
      .map(([, value]) => value.replace(/^\S+\s+/, ""))];
  const redacted = redactSensitiveValueOccurrences(message, values) as string;
  const detail = redactSensitiveText(redacted)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
  if (!detail) return fallback;
  const bounded = detail.length > 1000 ? `${detail.slice(0, 997)}...` : detail;
  // Screen exactly the normalized text that will reach the caller. Never
  // return or persist provider instructions through the error channel.
  try {
    await validateToolContent({ value: bounded, direction: "result",
      sensitiveMode: "redact", promptInjectionMode: "block", classifier });
  } catch (error) {
    if (error instanceof ToolContentValidationError) return fallback;
    throw error;
  }
  return `${fallback}. Upstream message (untrusted): ${bounded}`;
}
