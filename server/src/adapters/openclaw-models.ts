import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { models as openclawFallbackModels } from "@paperclipai/adapter-openclaw-gateway";
import type { AdapterModel } from "./types.js";

const OPENCLAW_MODELS_CACHE_TTL_MS = 60_000;

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function parseModelArray(value: unknown): AdapterModel[] {
  if (!Array.isArray(value)) return [];
  const models: AdapterModel[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const id = entry.trim();
      if (!id) continue;
      models.push({ id, label: id });
      continue;
    }
    const record = asRecord(entry);
    const id = nonEmpty(record?.id);
    if (!id) continue;
    models.push({ id, label: nonEmpty(record?.label) ?? id });
  }
  return sortModels(dedupeModels(models));
}

function parseOpenClawModelCatalog(payload: unknown): AdapterModel[] {
  const directModels = parseModelArray(payload);
  if (directModels.length > 0) return directModels;

  const root = asRecord(payload);
  if (!root) return [];

  const wrappedModels = parseModelArray(root.models);
  if (wrappedModels.length > 0) return wrappedModels;

  const providers = asRecord(root.providers);
  if (!providers) return [];

  const models: AdapterModel[] = [];
  for (const [providerId, providerValue] of Object.entries(providers)) {
    const provider = asRecord(providerValue);
    const providerModels = Array.isArray(provider?.models) ? provider.models : [];
    for (const entry of providerModels) {
      const model = asRecord(entry);
      const modelId = nonEmpty(model?.id);
      if (!modelId) continue;
      const id = `${providerId}/${modelId}`;
      models.push({ id, label: id });
    }
  }

  return sortModels(dedupeModels(models));
}

function resolveCatalogCandidates(): string[] {
  const candidates: string[] = [];
  const envPath = nonEmpty(process.env.PAPERCLIP_OPENCLAW_MODELS_FILE);
  if (envPath) candidates.push(envPath);

  const homeDir = nonEmpty(os.homedir());
  if (homeDir) {
    candidates.push(path.join(homeDir, ".openclaw", "agents", "main", "agent", "models.json"));
  }

  candidates.push("/paperclip/.openclaw/agents/main/agent/models.json");

  return Array.from(new Set(candidates));
}

async function readCatalogFile(filePath: string): Promise<AdapterModel[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseOpenClawModelCatalog(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function discoverOpenClawModels(): Promise<AdapterModel[]> {
  const envJson = nonEmpty(process.env.PAPERCLIP_OPENCLAW_MODELS_JSON);
  if (envJson) {
    try {
      const parsed = parseOpenClawModelCatalog(JSON.parse(envJson));
      if (parsed.length > 0) return parsed;
    } catch {
      // Ignore invalid inline JSON and continue to file discovery.
    }
  }

  for (const candidate of resolveCatalogCandidates()) {
    const parsed = await readCatalogFile(candidate);
    if (parsed.length > 0) return parsed;
  }

  return [];
}

export async function listOpenClawGatewayModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.models;
  }

  const discovered = await discoverOpenClawModels();
  const models = discovered.length > 0
    ? discovered
    : sortModels(dedupeModels(openclawFallbackModels));

  cached = {
    expiresAt: now + OPENCLAW_MODELS_CACHE_TTL_MS,
    models,
  };
  return models;
}

export async function refreshOpenClawGatewayModels(): Promise<AdapterModel[]> {
  cached = null;
  return listOpenClawGatewayModels();
}

export function resetOpenClawGatewayModelsCacheForTests() {
  cached = null;
}