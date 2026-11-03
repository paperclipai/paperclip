/** Redact diagnostic text without importing the provider process or its credentials. */
export function redactCodexDiagnostic(message: string): string {
  return message
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+([A-Za-z0-9+/=]+)/gi, (match, encoded: string) => {
      try {
        // Only redact an actual RFC 7617 credential. Ordinary prose such as
        // “Basic API” must remain readable.
        const decoded = Buffer.from(encoded, "base64").toString("utf8");
        return decoded.includes(":") ? "Basic [REDACTED]" : match;
      } catch {
        return match;
      }
    })
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(
      /([?&](?:api[_-]?key|token|secret|password)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["'](?:api[_-]?key|token|secret|password|authorization)["']\s*:\s*["'])[^"']+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /((?:[A-Z][A-Z0-9]*_)+API_KEY)=[^\s]+/g,
      "$1=[REDACTED]",
    );
}
