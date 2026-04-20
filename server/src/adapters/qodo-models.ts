import type { AdapterModel } from "./types.js";
import { models as qodoFallbackModels } from "@paperclipai/adapter-qodo-local";

const CACHE_TTL_MS = 120_000;
let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

async function fetchQodoModels(): Promise<AdapterModel[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);

  try {
    const { stdout } = await exec("qodo", ["models"], { timeout: 10_000 });
    const models: AdapterModel[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^-\s+(.+)$/);
      if (!match) continue;
      const id = match[1].trim();
      if (id) models.push({ id, label: id });
    }
    return models;
  } catch {
    return [];
  }
}

let inflight: Promise<AdapterModel[]> | null = null;

export async function listQodoModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.models;

  if (!inflight) {
    inflight = fetchQodoModels().finally(() => { inflight = null; });
  }
  const fetched = await inflight;
  if (fetched.length > 0) {
    cached = { expiresAt: Date.now() + CACHE_TTL_MS, models: fetched };
    return fetched;
  }

  return qodoFallbackModels;
}
