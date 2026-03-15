import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function parseScopes(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildOpenClawGatewayConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  const url = v.url.trim();
  const gatewayToken = v.openClawGatewayToken.trim();
  const sessionKeyStrategy =
    v.openClawSessionKeyStrategy === "fixed" ||
    v.openClawSessionKeyStrategy === "run" ||
    v.openClawSessionKeyStrategy === "issue"
      ? v.openClawSessionKeyStrategy
      : "issue";
  const scopes = parseScopes(v.openClawScopes);

  // Normalize pasted URLs so surrounding whitespace does not produce an invalid gateway config.
  if (url) ac.url = url;
  if (gatewayToken) {
    // The create form stores the token separately so we can render it cleanly and
    // still serialize the server-required header shape on submit.
    ac.headers = { "x-openclaw-token": gatewayToken };
  }
  if (v.openClawPaperclipApiUrl.trim()) ac.paperclipApiUrl = v.openClawPaperclipApiUrl.trim();
  ac.timeoutSec = 120;
  ac.waitTimeoutMs = parsePositiveInteger(v.openClawWaitTimeoutMs, 120000);
  ac.sessionKeyStrategy = sessionKeyStrategy;
  ac.role = v.openClawRole.trim() || "operator";
  ac.scopes = scopes.length > 0 ? scopes : ["operator.admin"];
  if (sessionKeyStrategy === "fixed") {
    ac.sessionKey = v.openClawSessionKey.trim() || "paperclip";
  }
  return ac;
}
