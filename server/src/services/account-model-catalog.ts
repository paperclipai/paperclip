import { unprocessable } from "../errors.js";

type Model = { id: string; label: string };
type Provider = "openai" | "anthropic";
type Method = "api_key" | "subscription";

export async function fetchAccountModels(provider: Provider, method: Method, credential: string, options?: {
  refreshCredential: (failedCredential: string, signal: AbortSignal) => Promise<string>;
}): Promise<Model[]> {
  let url: string;
  let headers: Record<string, string>;
  if (provider === "anthropic") {
    url = "https://api.anthropic.com/v1/models?limit=1000";
    headers = { "anthropic-version": "2023-06-01", ...(method === "api_key" ? { "x-api-key": credential } : { Authorization: `Bearer ${credential}`, "anthropic-beta": "oauth-2025-04-20" }) };
  } else if (method === "api_key") {
    url = "https://api.openai.com/v1/models";
    headers = { Authorization: `Bearer ${credential}` };
  } else {
    let auth: { tokens?: { access_token?: unknown; account_id?: unknown } };
    try { auth = JSON.parse(credential) ?? {}; } catch { throw unprocessable("Reconnect this Codex account to load its models"); }
    const token = auth.tokens?.access_token, account = auth.tokens?.account_id;
    if (typeof token !== "string" || !token || typeof account !== "string" || !account) throw unprocessable("Reconnect this Codex account to load its models");
    url = "https://chatgpt.com/backend-api/codex/models?client_version=0.166.0";
    headers = { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": account };
  }
  try {
    let response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (provider === "openai" && method === "subscription" && response.status === 401 && options?.refreshCredential) {
      await response.body?.cancel();
      const refreshed = JSON.parse(await options.refreshCredential(credential, AbortSignal.timeout(10_000)));
      const token = refreshed?.tokens?.access_token, account = refreshed?.tokens?.account_id;
      if (typeof token !== "string" || !token || account !== headers["ChatGPT-Account-Id"]) throw new Error("credential identity changed");
      headers = { ...headers, Authorization: `Bearer ${token}` };
      response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
    }
    if (!response.ok) throw new Error("provider rejected catalog request");
    const payload = await response.json() as { data?: unknown; models?: unknown; has_more?: unknown };
    const entries = method === "subscription" && provider === "openai" ? payload.models : payload.data;
    if (!Array.isArray(entries) || payload.has_more === true) throw new Error("incomplete provider catalog");
    const models: Model[] = [];
    for (const item of entries) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      if (provider === "openai" && method === "subscription" && value.visibility !== "list") continue;
      const id = provider === "openai" && method === "subscription" ? value.slug : value.id;
      if (typeof id !== "string" || !id.trim() || models.some(model => model.id === id)) continue;
      const label = value.display_name;
      models.push({ id, label: typeof label === "string" && label.trim() ? label : id });
    }
    return models;
  } catch {
    throw unprocessable("Could not load models for this account. Check its connection and try again.");
  }
}
