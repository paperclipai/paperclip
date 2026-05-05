import type { AdapterModel } from "@paperclipai/adapter-utils";
import { DEFAULT_OLLAMA_HOST } from "../index.js";

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    details?: { family?: string; parameter_size?: string };
  }>;
}

export const OLLAMA_CLOUD_HOST = "https://ollama.com";

export function resolveOllamaHost(explicit?: string | null): string {
  if (explicit && explicit.trim().length > 0) {
    const withScheme = /^https?:\/\//i.test(explicit.trim()) ? explicit.trim() : `http://${explicit.trim()}`;
    return withScheme.replace(/\/+$/, "");
  }
  const envHost = (process.env.OLLAMA_HOST ?? "").trim();
  if (envHost.length > 0) {
    const withScheme = /^https?:\/\//i.test(envHost) ? envHost : `http://${envHost}`;
    return withScheme.replace(/\/+$/, "");
  }
  return DEFAULT_OLLAMA_HOST;
}

export function isOllamaCloudHost(host: string): boolean {
  try {
    const url = new URL(host);
    return /(^|\.)ollama\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export function resolveOllamaApiKey(explicit?: string | null): string | null {
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const envKey = (process.env.OLLAMA_API_KEY ?? "").trim();
  return envKey.length > 0 ? envKey : null;
}

function buildAuthHeaders(host: string, apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey && (isOllamaCloudHost(host) || apiKey.length > 0)) {
    headers["authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

export async function fetchOllamaTags(
  host: string,
  options: { signal?: AbortSignal; apiKey?: string | null } = {},
): Promise<OllamaTagsResponse> {
  const url = `${host.replace(/\/+$/, "")}/api/tags`;
  const apiKey = resolveOllamaApiKey(options.apiKey ?? null);
  const res = await fetch(url, {
    signal: options.signal,
    headers: buildAuthHeaders(host, apiKey),
  });
  if (!res.ok) {
    throw new Error(`Ollama /api/tags returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as OllamaTagsResponse;
}

export async function listOllamaModels(
  host?: string,
  apiKey?: string | null,
): Promise<AdapterModel[]> {
  const resolvedHost = resolveOllamaHost(host);
  try {
    const tags = await fetchOllamaTags(resolvedHost, { apiKey });
    const models: AdapterModel[] = [];
    for (const entry of tags.models ?? []) {
      const id = (entry.name ?? entry.model ?? "").trim();
      if (!id) continue;
      const detail = entry.details?.parameter_size
        ? ` (${entry.details.parameter_size})`
        : "";
      models.push({ id, label: `${id}${detail}` });
    }
    return dedupeAndSort(models);
  } catch {
    return [];
  }
}

export interface OllamaPullProgressEvent {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

export interface OllamaShowResponse {
  capabilities?: string[];
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
  model_info?: Record<string, unknown>;
  modelfile?: string;
}

/**
 * Stream a model pull. Emits progress events as the daemon reports them.
 * Throws on HTTP error, on a JSON line with `error`, or if aborted.
 */
export async function pullOllamaModel(
  host: string,
  name: string,
  options: {
    apiKey?: string | null;
    signal?: AbortSignal;
    onProgress?: (event: OllamaPullProgressEvent) => void | Promise<void>;
    insecure?: boolean;
  } = {},
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("pullOllamaModel: name is required");
  const url = `${host.replace(/\/+$/, "")}/api/pull`;
  const apiKey = resolveOllamaApiKey(options.apiKey ?? null);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: trimmed,
      stream: true,
      ...(options.insecure ? { insecure: true } : {}),
    }),
    signal: options.signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama /api/pull returned ${res.status}: ${body.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof parsed.error === "string") {
        throw new Error(`Ollama pull failed: ${parsed.error}`);
      }
      if (options.onProgress) {
        const status = typeof parsed.status === "string" ? parsed.status : "";
        await options.onProgress({
          status,
          digest: typeof parsed.digest === "string" ? parsed.digest : undefined,
          total: typeof parsed.total === "number" ? parsed.total : undefined,
          completed: typeof parsed.completed === "number" ? parsed.completed : undefined,
        });
      }
    }
  }
}

export async function deleteOllamaModel(
  host: string,
  name: string,
  options: { apiKey?: string | null; signal?: AbortSignal } = {},
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("deleteOllamaModel: name is required");
  const url = `${host.replace(/\/+$/, "")}/api/delete`;
  const apiKey = resolveOllamaApiKey(options.apiKey ?? null);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ model: trimmed }),
    signal: options.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama /api/delete returned ${res.status}: ${body.slice(0, 500)}`);
  }
}

export async function showOllamaModel(
  host: string,
  name: string,
  options: { apiKey?: string | null; signal?: AbortSignal } = {},
): Promise<OllamaShowResponse> {
  const url = `${host.replace(/\/+$/, "")}/api/show`;
  const apiKey = resolveOllamaApiKey(options.apiKey ?? null);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: name.trim() }),
    signal: options.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama /api/show returned ${res.status}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as OllamaShowResponse;
}

/**
 * Returns true when the requested model supports tool calling, based on
 * Ollama's /api/show capabilities array.
 */
export async function modelSupportsTools(
  host: string,
  name: string,
  options: { apiKey?: string | null; signal?: AbortSignal } = {},
): Promise<boolean> {
  try {
    const info = await showOllamaModel(host, name, options);
    return Array.isArray(info.capabilities) && info.capabilities.includes("tools");
  } catch {
    return false;
  }
}

function dedupeAndSort(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const out: AdapterModel[] = [];
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
