// Read-only CPS experiment index scanner.
//
// Exposes the local experiment-tracker JSON produced under CPS self_practice.
// This service never runs experiments, never mutates CPS artifacts, never calls
// brokers/paid APIs, and never publishes signals.

import fs from "node:fs/promises";
import path from "node:path";
import type { CpsExperimentEntry, CpsExperimentOverview } from "@paperclipai/shared";

export interface CpsExperimentsServiceOptions {
  indexFile?: string;
  selfPracticeDir?: string;
  staleAfterMs?: number;
  recentLimit?: number;
}

const DEFAULT_SELF_PRACTICE_DIR = "/root/cps/var/self_practice";
const DEFAULT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const DEFAULT_RECENT_LIMIT = 40;

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asStringNumberRecord(value: unknown): Record<string, number> {
  const rec = asRecord(value);
  if (!rec) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(rec)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}

function parseDateMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function mapEntry(raw: unknown): CpsExperimentEntry | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = asString(rec.id);
  const updatedUtc = asString(rec.updated_utc) ?? asString(rec.updatedUtc);
  const kind = asString(rec.kind);
  const status = asString(rec.status);
  if (!id || !updatedUtc || !kind || !status) return null;
  const summary = asRecord(rec.summary) ?? {};
  return {
    id,
    runId: asString(rec.run_id) ?? asString(rec.runId) ?? id,
    path: asString(rec.path),
    absolutePath: asString(rec.absolute_path) ?? asString(rec.absolutePath),
    updatedUtc,
    kind,
    status,
    decision: asString(rec.decision),
    primaryJson: asString(rec.primary_json) ?? asString(rec.primaryJson),
    absolutePrimaryJson: asString(rec.absolute_primary_json) ?? asString(rec.absolutePrimaryJson),
    files: asStringArray(rec.files),
    summary,
  };
}

async function readIndex(indexFile: string): Promise<Json | null> {
  try {
    const text = await fs.readFile(indexFile, "utf8");
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

async function fileMtimeMs(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

async function resolveIndexFile(options: Pick<CpsExperimentsServiceOptions, "indexFile" | "selfPracticeDir">): Promise<string> {
  if (options.indexFile) return options.indexFile;
  if (process.env.PAPERCLIP_CPS_EXPERIMENTS_INDEX) return process.env.PAPERCLIP_CPS_EXPERIMENTS_INDEX;
  const base = options.selfPracticeDir ?? process.env.PAPERCLIP_CPS_SELF_PRACTICE_DIR ?? DEFAULT_SELF_PRACTICE_DIR;
  try {
    const entries = await fs.readdir(base, { withFileTypes: true });
    const latest = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("experiment-tracker-"))
      .map((entry) => entry.name)
      .sort()
      .at(-1);
    if (latest) return path.join(base, latest, "EXPERIMENTS_INDEX.json");
  } catch {
    // Fall through to the stable non-date fallback below.
  }
  return path.join(base, "EXPERIMENTS_INDEX.json");
}

export function cpsExperimentsService(options: CpsExperimentsServiceOptions = {}) {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;

  return {
    async overview(companyId: string): Promise<CpsExperimentOverview> {
      const indexFile = await resolveIndexFile(options);
      const raw = await readIndex(indexFile);
      const now = Date.now();
      const generatedAt = new Date(now).toISOString();
      const indexMtimeMs = await fileMtimeMs(indexFile);
      const sourceGeneratedMs = parseDateMs(asString(raw?.generated_utc) ?? asString(raw?.generatedAt));
      const freshestMs = sourceGeneratedMs ?? indexMtimeMs;
      const ageSeconds = freshestMs === null ? null : Math.max(0, Math.round((now - freshestMs) / 1000));
      const entries = Array.isArray(raw?.entries) ? raw.entries.map(mapEntry).filter((entry): entry is CpsExperimentEntry => entry !== null) : [];
      entries.sort((a, b) => b.updatedUtc.localeCompare(a.updatedUtc));

      return {
        companyId,
        generatedAt,
        source: {
          indexPath: path.normalize(indexFile),
          present: raw !== null,
          stale: ageSeconds !== null ? ageSeconds * 1000 > staleAfterMs : true,
          ageSeconds,
          schema: asString(raw?.schema),
          root: asString(raw?.root),
        },
        counts: {
          total: typeof raw?.entry_count === "number" ? raw.entry_count : entries.length,
          byKind: asStringNumberRecord(raw?.kind_counts),
          byStatus: asStringNumberRecord(raw?.status_counts),
          byDecision: asStringNumberRecord(raw?.decision_counts),
          strategyByDecision: asStringNumberRecord(raw?.strategy_decision_counts),
          evalByVerdict: asStringNumberRecord(raw?.eval_verdict_counts),
        },
        recent: entries.slice(0, recentLimit),
        entries,
        safety: {
          readOnly: true,
          brokerActions: false,
          paidComputeActions: false,
          paidDataActions: false,
          signalPublishing: false,
          note: "Reads the local CPS EXPERIMENTS_INDEX.json only; it does not run experiments or touch brokers/paid APIs.",
        },
      };
    },
  };
}
