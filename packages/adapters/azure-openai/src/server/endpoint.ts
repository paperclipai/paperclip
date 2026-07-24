/**
 * URL routing and API-surface detection.
 *
 * Two orthogonal axes:
 *   - endpointMode (URL construction): `deployment` vs `raw`
 *   - apiSurface   (request/response shape): `chat_completions` vs `responses`
 *
 * The `auto` value on apiSurface inspects the URL: paths ending in `/responses`
 * are treated as OpenAI Responses API; everything else as chat_completions.
 * This makes Foundry endpoints like
 *   https://foundry-x.services.ai.azure.com/openai/v1/responses
 * "just work" when the operator sets endpointMode=raw and leaves apiSurface=auto.
 */

import type {
  ApiSurface,
  DeploymentKind,
  EndpointMode,
} from "../shared/constants.js";

export function buildRequestUrl(args: {
  endpoint: string;
  deployment: string;
  apiVersion: string;
  deploymentKind: DeploymentKind;
  endpointMode: EndpointMode;
}): string {
  if (args.endpointMode === "raw") {
    return args.endpoint;
  }
  const base = args.endpoint.replace(/\/+$/, "");
  if (args.deploymentKind === "azure_ai_foundry") {
    return `${base}/chat/completions`;
  }
  const encoded = encodeURIComponent(args.deployment);
  return `${base}/openai/deployments/${encoded}/chat/completions?api-version=${encodeURIComponent(
    args.apiVersion,
  )}`;
}

/**
 * Resolve `apiSurface: auto` by inspecting the target URL. Explicit values
 * pass through unchanged.
 */
export function resolveApiSurface(apiSurface: ApiSurface, url: string): "chat_completions" | "responses" {
  if (apiSurface === "chat_completions" || apiSurface === "responses") return apiSurface;
  // auto
  const pathname = safePathname(url);
  if (pathname.endsWith("/responses")) return "responses";
  return "chat_completions";
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return url;
  }
}
