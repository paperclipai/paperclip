import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as staticModels } from "../index.js";

interface OpenRouterModel {
  id: string;
  name: string;
  pricing: {
    prompt: string;
    completion: string;
  };
  supported_parameters: string[];
  architecture: {
    input_modalities: string[];
  };
  expiration_date?: string | null;
}

interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

export function buildModelLabel(model: OpenRouterModel): string {
  const tags: string[] = [];

  if (model.pricing.prompt === "0" && model.pricing.completion === "0") {
    tags.push("free");
  }

  if (
    model.supported_parameters.includes("reasoning") ||
    model.supported_parameters.includes("include_reasoning")
  ) {
    tags.push("thinking");
  }

  if (model.architecture.input_modalities.includes("image")) {
    tags.push("vision");
  }

  if (model.supported_parameters.includes("structured_outputs")) {
    tags.push("structured");
  }

  if (model.supported_parameters.includes("parallel_tool_calls")) {
    tags.push("parallel-tools");
  }

  if (tags.length === 0) return model.name;
  return `${model.name} [${tags.join(", ")}]`;
}

function buildLeadingModels(): AdapterModel[] {
  const leading: AdapterModel[] = [...staticModels];
  const seen = new Set(leading.map((m) => m.id));

  for (const envVar of ["OPENROUTER_MODEL", "OPENROUTER_DEFAULT_MODEL", "OPENROUTER_LIGHT_MODEL"]) {
    const slug = process.env[envVar]?.trim();
    if (slug && !seen.has(slug)) {
      leading.push({ id: slug, label: slug });
      seen.add(slug);
    }
  }

  return leading;
}

function buildFallbackModels(): AdapterModel[] {
  return buildLeadingModels();
}

let cachedModels: AdapterModel[] | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function isExpired(model: OpenRouterModel): boolean {
  if (!model.expiration_date) return false;
  try {
    return new Date(model.expiration_date).getTime() <= Date.now();
  } catch {
    return false;
  }
}

export async function listModels(): Promise<AdapterModel[]> {
  if (cachedModels && Date.now() < cacheExpiresAt) {
    return cachedModels;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return [{ id: "", label: "Non-OpenRouter endpoint — enter model name manually" }];
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      throw new Error(`OpenRouter /models returned ${response.status}`);
    }

    const json = (await response.json()) as OpenRouterModelsResponse;
    const rawModels: OpenRouterModel[] = json.data ?? [];

    const filtered = rawModels.filter(
      (m) => m.supported_parameters.includes("tools") && !isExpired(m),
    );

    const sortKey = (id: string) => id.replace(/^~/, "");
    filtered.sort((a, b) => sortKey(a.id).localeCompare(sortKey(b.id)));

    const leading = buildLeadingModels();
    const leadingIds = new Set(leading.map((m) => m.id));
    // Upgrade leading model labels with API display names when available
    for (const lm of leading) {
      const apiModel = rawModels.find((m) => m.id === lm.id);
      if (apiModel) lm.label = buildModelLabel(apiModel);
    }
    const dynamic: AdapterModel[] = filtered
      .filter((m) => !leadingIds.has(m.id))
      .map((m) => ({ id: m.id, label: buildModelLabel(m) }));
    const result = [...leading, ...dynamic];

    cachedModels = result;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return result;
  } catch (err) {
    console.warn("openrouter-agent: failed to fetch models from OpenRouter", err);
    return buildFallbackModels();
  }
}

export async function refreshModels(): Promise<AdapterModel[]> {
  cachedModels = null;
  cacheExpiresAt = 0;
  return listModels();
}

export async function detectModel(): Promise<{
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
  lightModel?: string;
} | null> {
  const envModel = process.env.OPENROUTER_MODEL?.trim();
  const lightModel = process.env.OPENROUTER_LIGHT_MODEL?.trim();
  if (!envModel && !lightModel) return null;
  return {
    model: envModel ?? "",
    provider: "openrouter",
    source: envModel ? "env_OPENROUTER_MODEL" : "env_OPENROUTER_LIGHT_MODEL",
    ...(lightModel ? { lightModel } : {}),
  };
}
