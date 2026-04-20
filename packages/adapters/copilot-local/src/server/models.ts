/**
 * Copilot model discovery for copilot_local.
 *
 * Fetches available models from the Copilot API. When a `gheHost` hint is
 * provided (from the agent's config field), uses the GHE token; otherwise
 * uses the default github.com token.
 *
 * The models endpoint URL is discovered dynamically via /copilot_internal/user.
 * Falls back to a hardcoded list if the API call fails.
 */
import { runChildProcess, fetchWithRetry } from "@paperclipai/adapter-utils/server-utils";
import { buildCopilotHeaders, discoverCopilotApiUrl } from "./auth.js";

const FALLBACK_MODELS: Array<{ id: string; label: string }> = [
  { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-5-mini", label: "GPT-5 mini" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.2-codex", label: "GPT-5.2-Codex" },
  { id: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "grok-code-fast-1", label: "Grok Code Fast 1" },
];

/**
 * Get an auth token for a specific GitHub host via `gh auth token`.
 * Strips GITHUB_TOKEN/GH_TOKEN from env so gh reads from its own credential store.
 */
async function getTokenForHost(host?: string): Promise<string | null> {
  try {
    const args = ["auth", "token"];
    if (host) args.push("--hostname", host);
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env)
        .filter((e): e is [string, string] => typeof e[1] === "string")
        .filter(([k]) => k !== "GITHUB_TOKEN" && k !== "GH_TOKEN"),
    );
    const result = await runChildProcess(
      `copilot-token-${host ?? "default"}-${Date.now()}`,
      "gh",
      args,
      {
        cwd: process.cwd(),
        env: cleanEnv,
        timeoutSec: 10,
        graceSec: 2,
        onLog: async () => {},
      },
    );
    const token = (result.stdout ?? "").trim();
    if (token && (result.exitCode ?? 1) === 0 && !token.startsWith("ghp_")) {
      return token;
    }
  } catch {
    // ignore
  }
  return null;
}

interface CopilotModelRaw {
  id?: string;
  name?: string;
  model_picker_enabled?: boolean;
  vendor?: string;
  capabilities?: {
    type?: string;
  };
}

/**
 * Fetch models from the Copilot API using a specific token and discovered URL.
 * Only filters out embedding models — everything else is shown.
 */
async function fetchModelsWithToken(
  token: string,
  gheHost?: string,
): Promise<Array<{ id: string; label: string }>> {
  const discovered = await discoverCopilotApiUrl(token, gheHost);
  const baseUrl = discovered?.apiUrl ?? "https://api.githubcopilot.com";

  try {
    const response = await fetchWithRetry(`${baseUrl}/models`, {
      method: "GET",
      headers: buildCopilotHeaders(token),
    }, {
      timeoutMs: 10_000,
      maxRetries: 2,
      retryableStatuses: [429, 502, 503, 504],
    });
    if (!response.ok) return [];

    const body = (await response.json()) as unknown;
    const data = Array.isArray(body)
      ? (body as unknown[])
      : Array.isArray((body as Record<string, unknown>)?.data)
        ? ((body as Record<string, unknown>).data as unknown[])
        : null;
    if (!data) return [];

    const models: Array<{ id: string; label: string }> = [];
    for (const item of data) {
      const m = item as CopilotModelRaw;
      if (!m.id) continue;
      if (m.capabilities?.type === "embeddings") continue;
      if (m.id.includes("embedding")) continue;

      const label = m.name ?? m.id;
      const vendorHint =
        m.vendor && m.vendor !== "Azure OpenAI" && m.vendor !== "OpenAI"
          ? ` (${m.vendor})`
          : "";
      models.push({ id: m.id, label: `${label}${vendorHint}` });
    }

    // Deduplicate by id
    const seen = new Map<string, { id: string; label: string }>();
    for (const model of models) {
      if (!seen.has(model.id)) {
        seen.set(model.id, model);
      }
    }
    return Array.from(seen.values());
  } catch {
    return [];
  }
}

/**
 * Discover available Copilot models dynamically.
 *
 * @param hints - Optional config hints from the UI/route.
 *   `hints.gheHost` — GitHub Enterprise hostname for token resolution.
 */
export async function listCopilotLocalModels(
  hints?: Record<string, unknown>,
): Promise<Array<{ id: string; label: string }>> {
  const gheHost =
    typeof hints?.gheHost === "string" && hints.gheHost.trim().length > 0
      ? hints.gheHost.trim()
      : undefined;

  const tokenHost = gheHost ?? "github.com";
  const token = await getTokenForHost(tokenHost);
  if (!token) {
    // Try env vars as fallback — but ONLY for the default host (github.com).
    // Sending env-var tokens to an arbitrary gheHost would allow token
    // exfiltration via a user-controlled hostname (SSRF / credential leak).
    if (!gheHost) {
      const envToken =
        process.env.COPILOT_GITHUB_TOKEN?.trim() ||
        process.env.GH_TOKEN?.trim() ||
        process.env.GITHUB_TOKEN?.trim();
      if (envToken && !envToken.startsWith("ghp_")) {
        const models = await fetchModelsWithToken(envToken, undefined);
        return models.length > 0 ? models : FALLBACK_MODELS;
      }
    }
    return FALLBACK_MODELS;
  }

  const models = await fetchModelsWithToken(token, gheHost);
  return models.length > 0 ? models : FALLBACK_MODELS;
}
