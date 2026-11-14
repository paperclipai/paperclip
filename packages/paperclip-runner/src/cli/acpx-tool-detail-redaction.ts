import { redactObservabilityDiagnostic } from "../drivers/agent-observability.js";

/** Character limits runner-core enforces on a sidecar `toolDetail` field. */
const TOOL_DETAIL_TEXT_LIMITS: Readonly<Record<string, number>> = {
  toolName: 240,
  subject: 4_000,
  description: 4_000,
  blockedReason: 4_000,
};

/**
 * Remove credentials from tool display text: the run's observability header
 * values, an authorization header with its scheme and credential, a bare
 * bearer token, and `key=value`-style secrets. Runner-core redacts again and
 * the server removes registered secret values before anything is stored. The scheme is consumed with its credential so
 * no token fragment is left without its marker.
 */
export function redactToolDetailText(value: string, environment: NodeJS.ProcessEnv = process.env): string {
  return redactObservabilityDiagnostic(value, environment)
    .replace(
      /\b(authorization|proxy-authorization)\s*[:=]\s*(?:(?:bearer|basic|token|digest|negotiate)\s+)?[^\s,;}\]'"]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\bbearer\s+[^\s,;}\]'"]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b([A-Za-z0-9_-]*(?:key|token|secret|password|passwd|pwd)[A-Za-z0-9_-]*)\s*[:=]\s*[^\s,;&}\]'"]+/gi,
      (match, name: string) => (/\[REDACTED\]$/.test(match) ? match : `${name}=[REDACTED]`),
    );
}

/** Bound by Unicode code points, matching runner-core's character count. */
function boundCodePoints(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit).join("");
}

/**
 * Prepare a tool detail for the sidecar boundary: redact every display
 * string, then bound it again (redaction can lengthen text) so a long command
 * can never make runner-core reject the event and fail the turn.
 */
export function sidecarToolDetail(
  value: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): { toolDetail?: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const limit = TOOL_DETAIL_TEXT_LIMITS[key];
    if (typeof item === "string" && limit !== undefined) {
      const text = boundCodePoints(redactToolDetailText(item, environment), limit);
      if (text) output[key] = text;
    } else if ((key === "exitCode" || key === "durationMs") && typeof item === "number" && Number.isSafeInteger(item)) {
      if (key === "exitCode" || item >= 0) output[key] = item;
    }
  }
  return Object.keys(output).length > 0 ? { toolDetail: output } : {};
}
