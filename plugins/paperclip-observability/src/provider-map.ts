/**
 * Provider name mapping (adapter type → OTel well-known value).
 */

export function mapProvider(adapterType: string): string {
  switch (adapterType) {
    case "claude_local":
    case "claude":
      return "anthropic";
    case "openai":
    case "cursor_local":
    case "codex_local":
      return "openai";
    case "gemini_local":
    case "gemini":
      return "gcp.gemini";
    case "openclaw_gateway":
    case "openclaw":
      return adapterType;
    default:
      return adapterType || "unknown";
  }
}
