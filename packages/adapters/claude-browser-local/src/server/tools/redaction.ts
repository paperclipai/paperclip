/**
 * Redaction helpers. These run inside the sidecar, but are testable in
 * isolation. Redaction is the last thing that happens before an artifact
 * leaves the sidecar process — originals never touch disk.
 *
 * Two layers:
 * 1. `redactDomHtml` — mask password/secret nodes and any occurrence of a
 *    resolved secret value in the serialized HTML before upload.
 * 2. `redactScreenshotRegions` — given a list of bounding boxes for password/
 *    secret DOM nodes, return the list of rectangles the caller should paint
 *    over the raw screenshot buffer. The actual pixel paint happens in the
 *    sidecar (uses sharp/canvas there).
 */

export const SECRET_NODE_SELECTORS = [
  "input[type=password]",
  "[data-secret]",
  "[data-paperclip-secret]",
] as const;

export const REDACTED_MARKER = "[REDACTED]";

export interface RedactionContext {
  /**
   * Resolved secret values known to the sidecar. Used to do a reverse-search
   * in the HTML serializer; if any resolved secret appears in the serialized
   * markup (because a site reflected it into the DOM), we blank it out.
   */
  resolvedSecretValues: string[];
}

export function redactDomHtml(html: string, ctx: RedactionContext): string {
  let out = html;

  // 1. Blank the value attribute on password inputs.
  out = out.replace(
    /(<input\b[^>]*\btype\s*=\s*["']?password["']?[^>]*\bvalue\s*=\s*")([^"]*)(")/gi,
    (_match, head, _val, tail) => `${head}${REDACTED_MARKER}${tail}`,
  );

  // 2. Blank the value attribute on anything tagged data-secret.
  out = out.replace(
    /(<[^>]*\bdata-(?:paperclip-)?secret\b[^>]*\bvalue\s*=\s*")([^"]*)(")/gi,
    (_match, head, _val, tail) => `${head}${REDACTED_MARKER}${tail}`,
  );

  // 3. Replace any resolved secret value that leaked into the markup.
  for (const secret of ctx.resolvedSecretValues) {
    if (!secret || secret.length < 4) continue;
    const pattern = new RegExp(escapeRegExp(secret), "g");
    out = out.replace(pattern, REDACTED_MARKER);
  }

  return out;
}

export interface SecretBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  reason: "password" | "data-secret" | "resolved-value";
}

/**
 * Given bounding boxes for password/secret nodes, return the rectangles the
 * sidecar should paint over the raw screenshot. This function does not touch
 * pixels; the sidecar handles painting after deciding the list here.
 */
export function redactScreenshotRegions(
  boxes: SecretBoundingBox[],
): SecretBoundingBox[] {
  // Expand each box by 2px on every side so anti-aliased edges don't leak
  // characters. This matches what the demo test expects for password fields.
  return boxes.map((b) => ({
    x: Math.max(0, b.x - 2),
    y: Math.max(0, b.y - 2),
    width: b.width + 4,
    height: b.height + 4,
    reason: b.reason,
  }));
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
