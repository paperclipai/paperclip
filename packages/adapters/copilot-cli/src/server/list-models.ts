import type { AdapterModel } from "@paperclipai/adapter-utils";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

const CACHE_TTL_MS = 60_000;

const FALLBACK_MODELS: AdapterModel[] = [
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "o3", label: "o3" },
  { id: "o4-mini", label: "o4-mini" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
];

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const out: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: model.label.trim() || id });
  }
  return out;
}

function tokenizeLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function looksLikeModelId(token: string): boolean {
  // Be permissive: Copilot models are provider-dependent and may include dots/dashes.
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{1,80}$/.test(token);
}

function parseModelsFromText(stdout: string): AdapterModel[] {
  const lines = tokenizeLines(stdout);
  const models: AdapterModel[] = [];
  for (const line of lines) {
    // Common patterns:
    // - "gpt-4.1"
    // - "gpt-4.1  (default)"
    // - "- gpt-4.1"
    const cleaned = line.replace(/^[-*•]\s+/, "");
    const first = cleaned.split(/\s+/)[0]?.trim() ?? "";
    if (!looksLikeModelId(first)) continue;
    models.push({ id: first, label: first });
  }
  return dedupeModels(models);
}

async function tryCommand(command: string, args: string[]): Promise<AdapterModel[]> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const proc = await runChildProcess("copilot_list_models", command, args, {
    cwd: process.cwd(),
    env,
    stdin: "",
    timeoutSec: 5,
    graceSec: 1,
    onLog: async () => {},
  });
  if ((proc.exitCode ?? 1) !== 0) return [];
  return parseModelsFromText(proc.stdout);
}

export async function listCopilotModels(command = "gh"): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.models;

  // Copilot CLI does not guarantee a stable "list models" command across versions.
  // Try a few known patterns; fall back to a curated list when discovery fails.
  const candidates: string[][] = [
    ["copilot", "--list-models"],
    ["copilot", "models"],
    ["copilot", "config", "--list-models"],
  ];

  for (const args of candidates) {
    const discovered = await tryCommand(command, args);
    if (discovered.length > 0) {
      const merged = dedupeModels([...discovered, ...FALLBACK_MODELS]).sort((a, b) =>
        a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
      );
      cached = { expiresAt: now + CACHE_TTL_MS, models: merged };
      return merged;
    }
  }

  const fallback = dedupeModels(FALLBACK_MODELS);
  cached = { expiresAt: now + CACHE_TTL_MS, models: fallback };
  return fallback;
}

export function resetCopilotModelsCacheForTests() {
  cached = null;
}
