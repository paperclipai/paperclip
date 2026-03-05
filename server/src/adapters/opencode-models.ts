import { spawn } from "node:child_process";
import { models as opencodeFallbackModels } from "@paperclipai/adapter-opencode-local";
import type { AdapterModel } from "./types.js";

const TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;
const MAX_BUFFER = 512 * 1024;

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;
let runner: (() => Promise<{ status: number | null; stdout: string; stderr: string }>) | null = null;

function dedupe(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  return models.filter((m) => {
    const id = m.id.trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function parseOutput(stdout: string, stderr: string): AdapterModel[] {
  const models: AdapterModel[] = [];
  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    const id = line.trim();
    // Model IDs must contain at least one "/" (e.g., provider/model or openrouter/provider/model)
    if (id && id.includes("/") && !id.includes(" ")) {
      models.push({ id, label: id });
    }
  }
  return dedupe(models);
}

function spawnPromise(command: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const timeout = setTimeout(() => {
      killed = true;
      proc.kill();
      resolve({ status: null, stdout, stderr });
    }, TIMEOUT_MS);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_BUFFER) {
        killed = true;
        proc.kill();
        clearTimeout(timeout);
        resolve({ status: null, stdout: stdout.slice(0, MAX_BUFFER), stderr });
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_BUFFER) {
        killed = true;
        proc.kill();
        clearTimeout(timeout);
        resolve({ status: null, stdout, stderr: stderr.slice(0, MAX_BUFFER) });
      }
    });

    proc.on("close", (code) => {
      if (!killed) {
        clearTimeout(timeout);
        resolve({ status: code, stdout, stderr });
      }
    });

    proc.on("error", () => {
      if (!killed) {
        clearTimeout(timeout);
        resolve({ status: null, stdout, stderr });
      }
    });
  });
}

async function runCli(): Promise<{ status: number | null; stdout: string; stderr: string }> {
  if (runner) return runner();
  return spawnPromise("opencode", ["models"]);
}

export async function listOpenCodeModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cached?.expiresAt && cached.expiresAt > now) return cached.models;

  const result = await runCli();
  const discovered = result.status === 0 ? parseOutput(result.stdout, result.stderr) : [];

  if (discovered.length > 0) {
    const merged = dedupe([...discovered, ...opencodeFallbackModels]);
    cached = { expiresAt: now + CACHE_TTL_MS, models: merged };
    return merged;
  }

  // Cache fallback on failure to avoid repeated CLI calls
  const fallback = cached?.models ?? dedupe(opencodeFallbackModels);
  cached = { expiresAt: now + CACHE_TTL_MS, models: fallback };
  return fallback;
}

export function resetOpenCodeModelsCacheForTests() {
  cached = null;
}

export function setOpenCodeModelsRunnerForTests(fn: typeof runner) {
  runner = fn;
}
