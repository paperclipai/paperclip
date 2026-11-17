import { redactSensitiveText } from "../redaction.js";
import { redactSensitiveValueOccurrences } from "../middleware/redact-sensitive.js";

/** Only the protocol's message is diagnostic text. Never reflect arbitrary data,
 * stacks, or the raw response. Redact before truncating so a boundary cannot
 * turn a credential into an unrecognizable, partially exposed value. */
export function mcpErrorMessage(
  fallback: string,
  error: unknown,
  headers: Record<string, string>,
  sensitiveValues: readonly string[] = [],
): string {
  if (!error || typeof error !== "object" || Array.isArray(error)) return fallback;
  const { message } = error as Record<string, unknown>;
  if (typeof message !== "string" || !message.trim()) return fallback;
  // Include opaque header values, even under provider-specific names. Also
  // remove the bare credential if the server omits the authorization scheme.
  const values = [...sensitiveValues, ...Object.values(headers),
    ...Object.entries(headers).filter(([key]) => key.toLowerCase() === "authorization")
      .map(([, value]) => value.replace(/^\S+\s+/, ""))];
  const redacted = redactSensitiveValueOccurrences(message, values) as string;
  const detail = redactSensitiveText(redacted)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
  if (!detail) return fallback;
  const bounded = detail.length > 1000 ? `${detail.slice(0, 997)}...` : detail;
  return `${fallback}. Upstream message (untrusted): ${bounded}`;
}
