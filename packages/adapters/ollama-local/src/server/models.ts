import type { AdapterModel } from "@paperclipai/adapter-utils";

interface OllamaTagModel {
  name: string;
  model?: string;
  size?: number;
  digest?: string;
  modified_at?: string;
}

interface OllamaTagsResponse {
  models: OllamaTagModel[];
}

function resolveOllamaBaseUrl(): string {
  return (
    (typeof process.env.PAPERCLIP_OLLAMA_BASE_URL === "string" &&
      process.env.PAPERCLIP_OLLAMA_BASE_URL.trim()) ||
    "http://localhost:11434"
  );
}

export async function discoverOllamaModels(baseUrl?: string): Promise<AdapterModel[]> {
  const url = `${(baseUrl ?? resolveOllamaBaseUrl()).replace(/\/$/, "")}/api/tags`;
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(
      `Could not reach Ollama at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama /api/tags returned ${res.status}: ${body.slice(0, 200)}`);
  }

  let data: OllamaTagsResponse;
  try {
    data = (await res.json()) as OllamaTagsResponse;
  } catch {
    throw new Error("Ollama /api/tags returned invalid JSON");
  }

  if (!Array.isArray(data.models)) return [];

  return data.models
    .map((m) => {
      const id = (m.name ?? m.model ?? "").trim();
      return id ? { id, label: id } : null;
    })
    .filter((m): m is AdapterModel => m !== null)
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
}

export async function listOllamaModels(baseUrl?: string): Promise<AdapterModel[]> {
  try {
    return await discoverOllamaModels(baseUrl);
  } catch {
    return [];
  }
}
