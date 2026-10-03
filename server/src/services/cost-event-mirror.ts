import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projectWorkspaces } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

type MirrorableCostEvent = {
  id: string;
  companyId: string;
  agentId: string | null;
  issueId: string | null;
  projectId: string | null;
  provider: string;
  biller: string | null;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt: Date | string;
};

const COST_EVENT_MIRROR_DIR = ".changes";

function utcDateKey(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function escapeNewlines(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

export function buildCostEventMirrorLine(event: MirrorableCostEvent): string {
  const ts = event.occurredAt instanceof Date ? event.occurredAt.toISOString() : new Date(event.occurredAt).toISOString();
  const payload = {
    event_id: event.id,
    provider: event.provider,
    model: event.model,
    agent: event.agentId,
    issue_id: event.issueId,
    project_id: event.projectId,
    tokens: {
      input: event.inputTokens,
      cached: event.cachedInputTokens,
      output: event.outputTokens,
    },
    cost_cents: event.costCents,
    ts,
  };
  return `${JSON.stringify(payload)}\n`;
}

export interface MirrorOptions {
  loggerOverride?: Pick<typeof logger, "warn" | "error">;
  fsOverride?: Pick<typeof fs, "appendFile" | "mkdir">;
  now?: () => Date;
}

export async function mirrorCostEventToWorkspace(
  db: Db,
  event: MirrorableCostEvent,
  options: MirrorOptions = {},
): Promise<{ written: boolean; path?: string }> {
  const log = options.loggerOverride ?? logger;
  const fsImpl = options.fsOverride ?? fs;
  const now = options.now ?? (() => new Date());

  if (!event.projectId) {
    return { written: false };
  }

  let cwd: string | null = null;
  try {
    const rows = await db
      .select({ cwd: projectWorkspaces.cwd })
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.projectId, event.projectId), eq(projectWorkspaces.isPrimary, true)))
      .limit(1);
    cwd = rows[0]?.cwd ?? null;
  } catch (err) {
    log.warn(
      { err, eventId: event.id, projectId: event.projectId },
      "cost_event_mirror: failed to look up project workspace cwd",
    );
    return { written: false };
  }

  if (!cwd) {
    log.warn(
      { eventId: event.id, projectId: event.projectId },
      "cost_event_mirror: project has no primary workspace cwd; skipping mirror",
    );
    return { written: false };
  }

  const dateKey = utcDateKey(event.occurredAt ?? now());
  const dir = path.join(cwd, COST_EVENT_MIRROR_DIR, dateKey);
  const file = path.join(dir, "cost-events.ndjson");

  try {
    await fsImpl.mkdir(dir, { recursive: true });
    const line = escapeNewlines(buildCostEventMirrorLine(event));
    await fsImpl.appendFile(file, line, { encoding: "utf8", flag: "a" });
    return { written: true, path: file };
  } catch (err) {
    log.warn(
      { err, eventId: event.id, file },
      "cost_event_mirror: failed to append cost event to workspace ndjson",
    );
    return { written: false };
  }
}

export function parseCostSince(value: string | undefined, fallback = 0): number {
  if (!value || value.trim() === "") return fallback;
  const raw = value.trim();
  const relativeMatch = raw.match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (relativeMatch) {
    const amount = Number.parseInt(relativeMatch[1] ?? "", 10);
    const unit = (relativeMatch[2] ?? "").toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`invalid --since duration: ${value}`);
    }
    const msPerUnit: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
    };
    return Date.now() - amount * msPerUnit[unit]!;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`invalid --since value: ${value}`);
  }
  return parsed;
}

export function listCostEventDateKeys(fromMs: number, toMs: number): string[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];
  const start = new Date(fromMs);
  const end = new Date(toMs);
  const keys: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const stop = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cursor.getTime() <= stop.getTime()) {
    keys.push(utcDateKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

export interface ReadCostEventsOptions {
  since?: string;
  until?: string;
  limit?: number;
  fsOverride?: Pick<typeof fs, "readFile" | "readdir" | "stat">;
  loggerOverride?: Pick<typeof logger, "warn" | "error">;
}

export interface CostEventMirrorRecord {
  raw: string;
  parsed: Record<string, unknown> | null;
  occurredAtMs: number | null;
}

export async function readCostEventsMirror(
  cwd: string,
  options: ReadCostEventsOptions = {},
): Promise<CostEventMirrorRecord[]> {
  const fsImpl = options.fsOverride ?? fs;
  const log = options.loggerOverride ?? logger;
  const limit = options.limit ?? 500;
  let fromMs: number;
  let toMs: number;
  try {
    fromMs = options.since ? parseCostSince(options.since) : 0;
    toMs = options.until ? parseCostSince(options.until) : Date.now();
  } catch (err) {
    log.warn({ err, cwd }, "cost_event_mirror: invalid since/until duration");
    return [];
  }
  const dateKeys = listCostEventDateKeys(fromMs, toMs);
  const records: CostEventMirrorRecord[] = [];
  for (const dateKey of dateKeys) {
    const file = path.join(cwd, COST_EVENT_MIRROR_DIR, dateKey, "cost-events.ndjson");
    let contents: string;
    try {
      contents = await fsImpl.readFile(file, { encoding: "utf8" });
    } catch (err) {
      // Missing day files are expected; skip silently. Other errors get a warn.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn({ err, file }, "cost_event_mirror: failed to read day file");
      }
      continue;
    }
    const lines = contents.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: Record<string, unknown> | null = null;
      let occurredAtMs: number | null = null;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const ts = parsed["ts"];
        if (typeof ts === "string") {
          const ms = Date.parse(ts);
          if (!Number.isNaN(ms)) occurredAtMs = ms;
        }
      } catch {
        parsed = null;
      }
      if (parsed === null) continue;
      if (occurredAtMs !== null && (occurredAtMs < fromMs || occurredAtMs > toMs)) continue;
      records.push({ raw: trimmed, parsed, occurredAtMs });
      if (records.length >= limit) return records;
    }
  }
  return records;
}

export const __testUtils = {
  utcDateKey,
  escapeNewlines,
  parseCostSince,
  listCostEventDateKeys,
};