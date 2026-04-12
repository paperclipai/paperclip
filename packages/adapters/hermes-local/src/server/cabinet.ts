/**
 * Cabinet Memory API integration for Hermes adapter.
 *
 * Cabinet provides a shared memory layer across agents. When enabled,
 * the hermes_local adapter appends task completion entries and can
 * pull relevant context before agent execution.
 */

const DEFAULT_CABINET_ENDPOINT = "http://localhost:3000";

export interface CabinetConfig {
  endpoint: string;
  slug: string;
  memorySync: "bidirectional" | "push" | "pull" | "off";
  autoAppend: boolean;
}

export function resolveCabinetConfig(config: Record<string, unknown>): CabinetConfig {
  const endpoint = asString(config.cabinetEndpoint, DEFAULT_CABINET_ENDPOINT).replace(/\/+$/, "");
  const slug = asString(config.cabinetSlug, "").trim();
  const syncRaw = asString(config.cabinetMemorySync, "push").trim().toLowerCase();
  const autoAppend = asBool(config.cabinetAutoAppend, true);

  const memorySync = (
    ["bidirectional", "push", "pull", "off"].includes(syncRaw) ? syncRaw : "push"
  ) as CabinetConfig["memorySync"];

  return { endpoint, slug, memorySync, autoAppend };
}

export interface CabinetMemoryEntry {
  file: string;
  entry: string;
}

/**
 * Append a memory entry to Cabinet.
 * POST /api/memory/:slug/append
 */
export async function appendMemory(
  config: CabinetConfig,
  entry: CabinetMemoryEntry,
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (config.memorySync === "off" || config.memorySync === "pull" || !config.autoAppend) {
    return { ok: true, status: 200 };
  }
  if (!config.slug) {
    return { ok: false, status: 0, error: "No cabinet slug configured" };
  }

  const url = `${config.endpoint}/api/memory/${encodeURIComponent(config.slug)}/append`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: body.slice(0, 200) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : "Unknown Cabinet error",
    };
  }
}

/**
 * Read a memory file from Cabinet.
 * GET /api/memory/:slug/:file
 */
export async function readMemory(
  config: CabinetConfig,
  file: string,
): Promise<{ ok: boolean; content?: string; status: number; error?: string }> {
  if (!config.slug) {
    return { ok: false, status: 0, error: "No cabinet slug configured" };
  }

  const url = `${config.endpoint}/api/memory/${encodeURIComponent(config.slug)}/${encodeURIComponent(file)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const content = await res.text();
    return { ok: true, content, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : "Unknown Cabinet error",
    };
  }
}

/**
 * List memory files in a Cabinet slug.
 * GET /api/memory/:slug
 */
export async function listMemoryFiles(
  config: CabinetConfig,
): Promise<{ ok: boolean; files: string[]; status: number; error?: string }> {
  if (!config.slug) {
    return { ok: false, files: [], status: 0, error: "No cabinet slug configured" };
  }

  const url = `${config.endpoint}/api/memory/${encodeURIComponent(config.slug)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { ok: false, files: [], status: res.status, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    const files = Array.isArray(data?.files) ? data.files : Array.isArray(data) ? data : [];
    return { ok: true, files, status: res.status };
  } catch (err) {
    return {
      ok: false,
      files: [],
      status: 0,
      error: err instanceof Error ? err.message : "Unknown Cabinet error",
    };
  }
}

/**
 * Build a bootstrap prompt that includes Cabinet context.
 * This is injected before the agent's main task prompt.
 */
export function buildCabinetBootstrapPrompt(
  cabinetConfig: CabinetConfig,
  context: { agentName: string; taskDescription: string; runId: string },
): string {
  if (cabinetConfig.memorySync === "off" || !cabinetConfig.slug) {
    return "";
  }

  const lines = [
    `## Cabinet Memory Context`,
    ``,
    `You are connected to Cabinet shared memory at ${cabinetConfig.endpoint}.`,
    `Memory slug: ${cabinetConfig.slug}`,
    `Sync mode: ${cabinetConfig.memorySync}`,
    ``,
  ];

  if (cabinetConfig.memorySync === "push" || cabinetConfig.memorySync === "bidirectional") {
    lines.push(
      `After completing your task, your output will be automatically appended to Cabinet memory.`,
      `To manually write to Cabinet, POST to ${cabinetConfig.endpoint}/api/memory/${cabinetConfig.slug}/append`,
      `with body: { "file": "context.md", "entry": "your memory entry" }`,
      ``,
    );
  }

  if (cabinetConfig.memorySync === "pull" || cabinetConfig.memorySync === "bidirectional") {
    lines.push(
      `You can read shared memory from Cabinet:`,
      `GET ${cabinetConfig.endpoint}/api/memory/${cabinetConfig.slug}/{filename}`,
      ``,
    );
  }

  return lines.join("\n");
}

/**
 * Build a task completion memory entry for Cabinet append.
 */
export function buildTaskCompletionEntry(params: {
  agentName: string;
  runId: string;
  taskDescription: string;
  result: string;
  exitCode: number | null;
}): CabinetMemoryEntry {
  const timestamp = new Date().toISOString();
  const status = (params.exitCode ?? 0) === 0 ? "completed" : "failed";
  const entry = [
    `## Task ${status} — ${timestamp}`,
    ``,
    `**Agent:** ${params.agentName}`,
    `**Run ID:** ${params.runId}`,
    `**Status:** ${status}`,
    ``,
    `### Task`,
    params.taskDescription,
    ``,
    `### Result`,
    params.result.slice(0, 2000),
    ``,
  ].join("\n");

  return { file: "context.md", entry };
}

// --- helpers ---

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const norm = value.trim().toLowerCase();
    if (norm === "true" || norm === "1") return true;
    if (norm === "false" || norm === "0") return false;
  }
  return fallback;
}
