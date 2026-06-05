import { DEFAULT_LOCAL_BASE_URL } from "../index.js";

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const MS_PER_SECOND = 1_000;

export interface LocalInferenceHealth {
  available: boolean;
  url: string;
  models: string[];
  error?: string;
}

interface ProbeOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutSec?: number;
}

interface ModelsResponse {
  object?: string;
  data?: Array<{ id?: unknown }>;
}

function readTimeoutMs(timeoutSec?: number): number {
  if (!Number.isFinite(timeoutSec) || !timeoutSec || timeoutSec <= 0) {
    return DEFAULT_PROBE_TIMEOUT_MS;
  }
  return Math.max(1, Math.trunc(timeoutSec * MS_PER_SECOND));
}

function readEnvTimeoutSec(): number | undefined {
  const parsed = Number(process.env.INFERENCE_LOCAL_TIMEOUT_S);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function normalizeLocalBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_LOCAL_BASE_URL;
}

export function resolveLocalBaseUrl(baseUrl?: string): string {
  return normalizeLocalBaseUrl(
    process.env.INFERENCE_LOCAL_URL_OVERRIDE || baseUrl || DEFAULT_LOCAL_BASE_URL,
  );
}

function forcedHealth(url: string): LocalInferenceHealth | null {
  if (process.env.INFERENCE_LOCAL_FORCE === "on") {
    const models = (process.env.INFERENCE_LOCAL_MODELS ?? "").split(",").filter(Boolean);
    return { available: true, url, models };
  }
  if (process.env.INFERENCE_LOCAL_FORCE === "off") {
    return { available: false, url, models: [] };
  }
  if (process.env.INFERENCE_LOCAL_AVAILABLE === "0") {
    return { available: false, url, models: [] };
  }
  if (process.env.INFERENCE_LOCAL_AVAILABLE === "1") {
    const models = (process.env.INFERENCE_LOCAL_MODELS ?? "").split(",").filter(Boolean);
    return { available: true, url, models };
  }
  return null;
}

function parseModelIds(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
  const parsed = payload as ModelsResponse;
  if (parsed.object !== "list" || !Array.isArray(parsed.data)) return [];
  return parsed.data
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

async function fetchModels(url: string, timeoutMs: number, apiKey = ""): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetch(`${url}/models`, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function getLocalInferenceHealth(
  options: ProbeOptions = {},
): Promise<LocalInferenceHealth> {
  const url = resolveLocalBaseUrl(options.baseUrl);
  const forced = forcedHealth(url);
  if (forced) return forced;

  try {
    const payload = await fetchModels(
      url,
      readTimeoutMs(options.timeoutSec ?? readEnvTimeoutSec()),
      options.apiKey,
    );
    const models = parseModelIds(payload);
    return { available: true, url, models };
  } catch (error) {
    return {
      available: false,
      url,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listLocalModels(): Promise<Array<{ id: string; label: string }>> {
  const health = await getLocalInferenceHealth();
  return health.models
    .filter((id) => !id.startsWith("text-embedding"))
    .map((id) => ({ id, label: id }));
}
