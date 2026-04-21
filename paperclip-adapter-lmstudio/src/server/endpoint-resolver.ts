import { probeEndpoint } from "./llm-client.js";

export interface Endpoint {
  url: string;
  model: string;
}

export interface ResolveParams {
  primaryUrl: string;
  primaryModel: string;
  fallbackUrl: string;
  fallbackModel: string;
  probeTimeoutMs: number;
}

export type ResolveResult =
  | {
      ok: true;
      endpoint: Endpoint;
      usingFallback: boolean;
      primaryFailureReason?: string;
    }
  | {
      ok: false;
      errorMessage: string;
    };

export async function resolvePrimaryOrFallback(p: ResolveParams): Promise<ResolveResult> {
  const primaryProbe = await probeEndpoint(p.primaryUrl, p.probeTimeoutMs);
  if (primaryProbe.ok) {
    return {
      ok: true,
      endpoint: { url: p.primaryUrl, model: p.primaryModel },
      usingFallback: false,
    };
  }

  if (!p.fallbackUrl) {
    return {
      ok: false,
      errorMessage: `LM Studio primary nicht erreichbar: ${p.primaryUrl} (${primaryProbe.reason}). Kein Fallback konfiguriert.`,
    };
  }

  const fallbackProbe = await probeEndpoint(p.fallbackUrl, p.probeTimeoutMs);
  if (!fallbackProbe.ok) {
    return {
      ok: false,
      errorMessage:
        `LM Studio nicht erreichbar:\n` +
        `  primary = ${p.primaryUrl} (${primaryProbe.reason})\n` +
        `  fallback = ${p.fallbackUrl} (${fallbackProbe.reason})`,
    };
  }

  return {
    ok: true,
    endpoint: {
      url: p.fallbackUrl,
      model: p.fallbackModel || p.primaryModel,
    },
    usingFallback: true,
    primaryFailureReason: primaryProbe.reason,
  };
}
