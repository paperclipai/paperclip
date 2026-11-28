import { spawn } from "node:child_process";
import type { AdapterModel } from "./types.js";

/**
 * Codex App Server's model/list is account- and CLI-specific. Unlike the
 * general OpenAI models API, it returns models intended for Codex execution.
 * Keep the curated fallback in registry.ts for unavailable/older CLIs.
 *
 * This is host-local discovery: it uses the credentials and Codex binary of
 * the Paperclip service account, never another OS user's model cache.
 */
const TIMEOUT_MS = 10_000;
const CACHE_MS = 300_000;
const FAILURE_RETRY_MS = 30_000;
const MAX_OUTPUT_BYTES = 2_000_000;
const MAX_PAGES = 4;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

let cached: { models: AdapterModel[]; expiresAt: number } | null = null;
let pending: Promise<AdapterModel[]> | null = null;

export function normalizeCodexAppServerModels(rows: unknown[]): AdapterModel[] {
  const seen = new Set<string>();
  const result: AdapterModel[] = [];
  for (const item of rows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim()
      : typeof row.model === "string" ? row.model.trim() : "";
    if (!ID.test(id) || seen.has(id) || row.hidden === true) continue;
    if (Array.isArray(row.inputModalities) && !row.inputModalities.includes("text")) continue;
    seen.add(id);
    const name = typeof row.displayName === "string" && row.displayName.trim()
      ? row.displayName.trim() : id;
    result.push({ id, label: name.slice(0, 120) });
  }
  return result;
}

async function queryCodexAppServer(): Promise<AdapterModel[]> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("codex", ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "ignore"],
        shell: false,
      });
    } catch {
      resolve([]);
      return;
    }

    let completed = false;
    let buffer = "";
    let receivedBytes = 0;
    let page = 0;
    const models: unknown[] = [];
    const finish = (result: AdapterModel[]) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      child.stdin?.end();
      child.kill();
      resolve(result);
    };
    const send = (message: Record<string, unknown>) => {
      if (completed || !child.stdin?.writable) return;
      try {
        child.stdin.write(JSON.stringify(message) + "\n");
      } catch {
        finish([]);
      }
    };
    const timer = setTimeout(() => finish([]), TIMEOUT_MS);
    child.on("error", () => finish([]));
    child.on("exit", () => finish([]));
    child.stdin?.on("error", () => finish([]));
    child.stdout?.on("error", () => finish([]));

    const handle = (raw: string) => {
      let message: Record<string, unknown>;
      try {
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        message = value as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.id === 1) {
        if (!message.result) return finish([]);
        send({ method: "initialized", params: {} });
        send({ id: 2, method: "model/list", params: { limit: 100, includeHidden: false } });
        return;
      }
      if (typeof message.id !== "number" || message.id !== 2 + page) return;
      const response = message.result as { data?: unknown; nextCursor?: unknown } | undefined;
      if (!response || !Array.isArray(response.data)) return finish([]);
      models.push(...response.data);
      const cursor = response.nextCursor;
      page++;
      if (typeof cursor === "string" && cursor.length > 0 && page < MAX_PAGES) {
        send({ id: 2 + page, method: "model/list",
          params: { limit: 100, includeHidden: false, cursor } });
      } else {
        finish(normalizeCodexAppServerModels(models));
      }
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (completed) return;
      const value = chunk.toString();
      receivedBytes += Buffer.byteLength(value);
      if (receivedBytes > MAX_OUTPUT_BYTES) return finish([]);
      buffer += value;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1 && !completed) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handle(line);
      }
    });
    send({ id: 1, method: "initialize",
      params: { clientInfo: { name: "paperclip-model-discovery",
        title: "Paperclip Codex model discovery", version: "1.0.0" },
        capabilities: {} } });
  });
}

/** Cache and coalesce discovery; refresh explicitly bypasses the TTL. */
export async function listCodexAppServerModels(options?: { refresh?: boolean }): Promise<AdapterModel[]> {
  const now = Date.now();
  if (!options?.refresh && cached && cached.expiresAt > now) return cached.models;
  if (pending) return pending;
  pending = queryCodexAppServer().then((models) => {
    if (models.length) cached = { models, expiresAt: Date.now() + CACHE_MS };
    else if (!cached) cached = { models: [], expiresAt: Date.now() + FAILURE_RETRY_MS };
    return models.length ? models : (cached?.models ?? []);
  }).finally(() => {
    pending = null;
  });
  return pending;
}

export function resetCodexAppServerModelsForTests() {
  cached = null;
  pending = null;
}
