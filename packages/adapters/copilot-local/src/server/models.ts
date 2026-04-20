import type { AdapterModel } from "@paperclipai/adapter-utils";
import { createCopilotClient } from "./sdk-client.js";
import {
  normalizeCopilotDiscoveredModels,
  normalizeRuntimeEnv,
} from "./runtime.js";
import { DEFAULT_COPILOT_LOCAL_MODEL, models as fallbackModels } from "../index.js";

const COPILOT_MODELS_CACHE_TTL_MS = 60_000;

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

async function safeStopClient(client: { stop(): Promise<unknown> } | null): Promise<void> {
  if (!client) return;
  try {
    await client.stop();
  } catch {
    // best-effort cleanup
  }
}

export async function discoverCopilotModels(): Promise<AdapterModel[]> {
  const runtimeEnv = normalizeRuntimeEnv(process.env);
  const githubToken = (runtimeEnv.GH_TOKEN ?? runtimeEnv.GITHUB_TOKEN ?? "").trim();
  if (!githubToken) return [];

  const client = await createCopilotClient({
    cwd: process.cwd(),
    env: runtimeEnv,
    githubToken,
    useLoggedInUser: false,
    logLevel: "error",
  });

  try {
    await client.start();

    try {
      const authStatus = await client.getAuthStatus();
      if (!authStatus.isAuthenticated) return [];
    } catch {
      // Older or partial runtimes can still succeed at listModels without auth.getStatus.
    }

    return normalizeCopilotDiscoveredModels(await client.listModels());
  } finally {
    await safeStopClient(client);
  }
}

export async function listModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.models;

  try {
    const models = await discoverCopilotModels();
    if (models.length > 0) {
      cached = {
        expiresAt: now + COPILOT_MODELS_CACHE_TTL_MS,
        models,
      };
    }
    return models;
  } catch {
    return [];
  }
}

export function resetCopilotModelsCacheForTests(): void {
  cached = null;
}

export const listCopilotModels = listModels;

export async function detectCopilotModel(): Promise<{
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
} | null> {
  const discovered = await listModels();
  const candidates = discovered.length > 0 ? discovered : fallbackModels;
  const selected =
    candidates.find((candidate) => candidate.id === DEFAULT_COPILOT_LOCAL_MODEL) ?? candidates[0];
  if (!selected) return null;
  return {
    model: selected.id,
    provider: "github",
    source: discovered.length > 0 ? "copilot-sdk" : "fallback",
    candidates: candidates.map((candidate) => candidate.id),
  };
}
