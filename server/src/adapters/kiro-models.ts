import type { AdapterModel } from "./types.js";
import { models as kiroFallbackModels } from "@paperclipai/adapter-kiro-local";

const CACHE_TTL_MS = 120_000;
let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

async function fetchKiroModels(): Promise<AdapterModel[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);

  try {
    const { stdout } = await exec("kiro-cli", ["chat", "--list-models", "--format", "json"], {
      timeout: 10_000,
      env: { ...process.env, TERM: "dumb" },
    });
    const parsed = JSON.parse(stdout);
    const models: AdapterModel[] = [];
    const items = Array.isArray(parsed) ? parsed : parsed?.models ?? [];
    for (const item of items) {
      const id = typeof item === "string" ? item : item?.id ?? item?.name;
      if (id) models.push({ id, label: typeof item === "object" ? item.label ?? id : id });
    }
    return models;
  } catch {
    return [];
  }
}

let inflight: Promise<AdapterModel[]> | null = null;

export async function listKiroModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.models;

  if (!inflight) {
    inflight = fetchKiroModels().finally(() => { inflight = null; });
  }
  const fetched = await inflight;
  if (fetched.length > 0) {
    cached = { expiresAt: Date.now() + CACHE_TTL_MS, models: fetched };
    return fetched;
  }

  return kiroFallbackModels;
}
