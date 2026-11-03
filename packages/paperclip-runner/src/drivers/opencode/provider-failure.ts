import { createProviderFailure } from "../provider-failure.js";

export function openCodeProviderFailure(error: Record<string, unknown>, provider: string,
  environment: NodeJS.ProcessEnv = {}) {
  const data = error.data && typeof error.data === "object" ? error.data as Record<string, unknown> : {};
  const message = typeof data.message === "string" ? data.message : error.message;
  if (typeof message !== "string") return null;
  return createProviderFailure({ provider, phase: "turn", message, httpStatus: data.statusCode,
    providerCode: data.code ?? error.name, requestId: data.requestID,
    category: error.name === "ProviderAuthError" ? "authentication" : undefined, environment });
}
