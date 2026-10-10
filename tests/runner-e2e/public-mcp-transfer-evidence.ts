/** Transfer credentials are an intentional tool result, unlike provider/OAuth
 * secrets. Remove only these known values before the strict evidence writer.
 * The live model/tool loop still receives the original result. */
export function redactTransferEvidence(value: unknown, transferSecrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of [...transferSecrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[REDACTED_TRANSFER]");
    return text;
  }
  if (Array.isArray(value)) return value.map(entry => redactTransferEvidence(entry, transferSecrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactTransferEvidence(entry, transferSecrets)]));
  return value;
}
