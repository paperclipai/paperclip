import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { models as geminiFallbackModels } from "@paperclipai/adapter-gemini-local";
import type { AdapterModel } from "./types.js";

const execFileAsync = promisify(execFile);

const AGY_MODELS_TIMEOUT_MS = 5_000;
const GEMINI_MODELS_CACHE_TTL_MS = 60_000;
const GEMINI_REFRESH_COOLDOWN_MS = 10_000;
const ANSI_ESCAPE_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;
let discoveryGeneration = 0;
let lastRefreshAt = 0;
let inFlightDiscovery: { generation: number; promise: Promise<AdapterModel[]> } | null = null;

type ModelsCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  hasError: boolean;
};

type ModelsRunner = () => Promise<ModelsCommandResult>;
let customRunner: ModelsRunner | null = null;

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const result: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, label: model.label.trim() || id });
  }
  return result;
}

function resolveAgyExecutable(): string | null {
  const override = process.env.PAPERCLIP_ANTIGRAVITY_COMMAND?.trim();
  return override || null;
}

function defaultAntigravityDataDir(): string | null {
  const override = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (override) return override;
  if (process.env.PAPERCLIP_ANTIGRAVITY_COMMAND?.trim()) {
    return path.join(os.homedir(), ".gemini", "antigravity-cli");
  }
  return null;
}

async function runAgyModelsCommand(): Promise<ModelsCommandResult> {
  if (customRunner) return customRunner();
  const executable = resolveAgyExecutable();
  if (!executable) {
    return { status: 1, stdout: "", stderr: "", hasError: true };
  }
  const dataDir = defaultAntigravityDataDir();
  try {
    const { stdout, stderr } = await execFileAsync(executable, ["models"], {
      timeout: AGY_MODELS_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      env: {
        ...process.env,
        HOME: process.env.HOME || os.homedir(),
        ...(dataDir ? { ANTIGRAVITY_APP_DATA_DIR: dataDir } : {}),
      },
    });
    return { status: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), hasError: false };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: unknown; stderr?: unknown };
    return {
      status: typeof e.code === "number" ? e.code : 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
      hasError: true,
    };
  }
}

export function parseAgyModelsOutput(stdout: string): AdapterModel[] {
  const cleaned = stdout.replace(ANSI_ESCAPE_PATTERN, "");
  const parsed: AdapterModel[] = [];
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /fetching available models/i.test(line)) continue;
    const match = /^([a-z0-9][a-z0-9._:/-]{2,})\s+(.+)$/i.exec(line);
    if (!match) continue;
    const id = match[1]!.trim();
    const label = match[2]!.trim();
    if (!id || !label || id.includes(" ")) continue;
    parsed.push({ id, label });
  }
  return dedupeModels(parsed);
}

export async function listGeminiModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cached && now < cached.expiresAt) {
    return cached.models;
  }

  const generation = discoveryGeneration;
  if (inFlightDiscovery && inFlightDiscovery.generation === generation) {
    return inFlightDiscovery.promise;
  }

  const run = (async () => {
    const res = await runAgyModelsCommand();
    const discovered = !res.hasError && res.status === 0
      ? parseAgyModelsOutput(res.stdout)
      : [];

    const merged = discovered.length > 0
      ? dedupeModels([
          geminiFallbackModels[0]!,
          ...discovered,
          ...geminiFallbackModels.slice(1),
        ])
      : [...geminiFallbackModels];

    if (generation === discoveryGeneration) {
      cached = { expiresAt: Date.now() + GEMINI_MODELS_CACHE_TTL_MS, models: merged };
      return merged;
    }
    return cached ? cached.models : merged;
  })().finally(() => {
    if (inFlightDiscovery?.generation === generation) {
      inFlightDiscovery = null;
    }
  });

  inFlightDiscovery = { generation, promise: run };
  return run;
}

export async function refreshGeminiModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  if (now - lastRefreshAt < GEMINI_REFRESH_COOLDOWN_MS) {
    if (inFlightDiscovery && inFlightDiscovery.generation === discoveryGeneration) {
      return inFlightDiscovery.promise;
    }
    if (cached) {
      return cached.models;
    }
  }
  lastRefreshAt = now;
  discoveryGeneration += 1;
  cached = null;
  return listGeminiModels();
}

export async function detectGeminiModel(): Promise<{
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
} | null> {
  try {
    const dataDir = defaultAntigravityDataDir();
    if (!dataDir) return null;
    const settingsPath = path.join(dataDir, "settings.json");
    if (!existsSync(settingsPath)) return null;
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { model?: unknown };
    const configured = typeof raw.model === "string" ? raw.model.trim() : "";
    if (!configured) return null;
    const available = await listGeminiModels();
    const normalized = configured.toLowerCase();
    const matched = available.find(
      (candidate) =>
        candidate.id.toLowerCase() === normalized ||
        candidate.label.toLowerCase() === normalized,
    );
    if (!matched && !configured.startsWith("gemini-")) return null;
    const modelId = matched?.id ?? configured;
    return {
      model: modelId,
      provider: "google",
      source: "antigravity-cli",
      candidates: available.filter((m) => m.id !== "auto").map((m) => m.id),
    };
  } catch {
    return null;
  }
}

export function setGeminiModelsRunnerForTests(runner: ModelsRunner | null): void {
  customRunner = runner;
}

export function resetGeminiModelsCacheForTests(): void {
  discoveryGeneration += 1;
  lastRefreshAt = 0;
  inFlightDiscovery = null;
  cached = null;
}
