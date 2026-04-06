import { asString, parseObject } from "../utils.js";

/**
 * Discovers available models from a running LM Studio instance
 * by calling its OpenAI-compatible /v1/models endpoint.
 */
export async function listLmStudioModels(
  config?: Record<string, unknown>,
): Promise<{ id: string; label: string }[]> {
  const parsed = parseObject(config ?? {});
  const apiBaseUrl = asString(parsed.apiBaseUrl, "http://localhost:1234/v1");
  const apiKey = asString(parsed.apiKey, "lm-studio");
  const modelsUrl = `${apiBaseUrl.replace(/\/+$/, "")}/models`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(modelsUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });

    if (!res.ok) return [];

    const data = (await res.json()) as {
      data?: Array<{ id: string; owned_by?: string }>;
    };

    return (data.data ?? []).map((m) => ({
      id: m.id,
      label: m.id,
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
