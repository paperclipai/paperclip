/**
 * Provider name mapping (adapter type → OTel well-known value).
 */

export function mapProvider(adapterType: string): string {
  switch (adapterType) {
    case "claude_local":
    case "claude":
      return "anthropic";
    case "openai":
    case "cursor-local":
    case "codex-local":
      return "openai";
    case "gemini-local":
      return "gcp.gemini";
    case "openclaw-gateway":
    case "openclaw":
      return adapterType;
    default:
      return adapterType || "unknown";
  }
}
