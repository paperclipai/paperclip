// lifecycle-guard wake field (SON-4117, rollout-checklist Step 6, control-plane side).
// Merges orphanedSessions (+orphanedSessionsTruncated) into Paperclip wake payloads and
// appends exact run_end records to the shared lifecycle-guard binding store.
// Spec: engineering-lead workspace
// runtime-lifecycle/v1b/lifecycle-guard/wake-field/orphanedSessions-wake-field.md
// Orphan predicate: vendored lifecycle-guard core (byte-identical to the hash-pinned
// gateway plugin build; see src/vendor/lifecycle-guard/PROVENANCE.md).

import { appendFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyRecord, computeOrphans, emptyState } from "../vendor/lifecycle-guard/core.js";

const MAX_ORPHAN_SESSIONS = 25;
const MAX_WRITES_PER_ORPHAN = 10;

export type LifecycleGuardOrphanedSession = {
  childSessionKey: string | null;
  parentRunId: string | null;
  stampedParentRunId: string | null;
  parentSessionKey: string | null;
  orphanReason: string | null;
  anchorAt: string | null;
  detectedAt: string | null;
  orphanWindowSeconds: number | null;
  writes: Array<{ ts: string | null; toolName: string | null; target: string | null }>;
};

export type LifecycleGuardWakeField = {
  orphanedSessions: LifecycleGuardOrphanedSession[] | null;
  orphanedSessionsTruncated: boolean;
  source: "store" | "feed" | "none";
};

export type LifecycleGuardRunEndResult = {
  appended: boolean;
  reason:
    | "recorded"
    | "idempotent"
    | "conflicting_run_end"
    | "store_unavailable"
    | "invalid_input";
};

export function lifecycleGuardStorePath(): string {
  return (
    process.env.PAPERCLIP_LIFECYCLE_GUARD_STORE_PATH?.trim() ||
    path.join(os.homedir(), ".openclaw", "lifecycle-guard", "bindings.jsonl")
  );
}

export function lifecycleGuardFeedPath(): string {
  return (
    process.env.PAPERCLIP_LIFECYCLE_GUARD_FEED_PATH?.trim() ||
    path.join(os.homedir(), ".openclaw", "lifecycle-guard", "orphaned-sessions.json")
  );
}

function readRecordLines(storePath: string): Array<Record<string, unknown>> {
  const raw = readFileSync(storePath, "utf8");
  const lines: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        lines.push(parsed as Record<string, unknown>);
      }
    } catch {
      // The store is append-only evidence; skip debris instead of failing the wake.
    }
  }
  return lines;
}

function tryReadStoreField(
  storePath: string,
  nowMs: number,
): LifecycleGuardWakeField | null {
  try {
    const state = emptyState();
    for (const record of readRecordLines(storePath)) {
      applyRecord(
        state,
        record as { type: string } & Record<string, unknown>,
      );
    }
    const orphans = computeOrphans(state, {
      nowMs,
      maxWrites: MAX_WRITES_PER_ORPHAN,
      maxSessions: MAX_ORPHAN_SESSIONS,
    }) as LifecycleGuardOrphanedSession[];
    return {
      orphanedSessions: Array.isArray(orphans) ? orphans : [],
      orphanedSessionsTruncated: false,
      source: "store",
    };
  } catch {
    return null;
  }
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Fallback feed: the v1-a wake-guard.sh sweep report (same predicate family, pre-plugin
// deployments). Entries carry a pid-shaped child reference and coarse timing only.
function tryReadFeedField(feedPath: string): LifecycleGuardWakeField | null {
  try {
    const parsed = JSON.parse(readFileSync(feedPath, "utf8")) as Record<string, unknown>;
    const entries = Array.isArray(parsed.orphanedSessions) ? parsed.orphanedSessions : [];
    const generatedAt = asStringOrNull(parsed.generatedAt);
    const orphans: LifecycleGuardOrphanedSession[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const childSessionKey =
        asStringOrNull(record.childSessionKey) ??
        (record.childPid != null ? `pid:${String(record.childPid)}` : null);
      orphans.push({
        childSessionKey,
        parentRunId: asStringOrNull(record.parentRunId),
        stampedParentRunId:
          asStringOrNull(record.stampedParentRunId) ??
          asStringOrNull(record.parentRunId),
        parentSessionKey: asStringOrNull(record.parentSessionKey),
        orphanReason: asStringOrNull(record.orphanReason) ?? "ttlExpiredPlusGrace",
        anchorAt: asStringOrNull(record.anchorAt),
        detectedAt: asStringOrNull(record.detectedAt) ?? generatedAt,
        orphanWindowSeconds:
          asNumberOrNull(record.orphanWindowSeconds) ??
          asNumberOrNull(record.overageSeconds),
        writes: [],
      });
      if (orphans.length >= MAX_ORPHAN_SESSIONS) break;
    }
    return {
      orphanedSessions: orphans,
      orphanedSessionsTruncated: entries.length > orphans.length,
      source: "feed",
    };
  } catch {
    return null;
  }
}

// Store first (primary, exact predicate); non-empty feed beats an empty store because
// the v1-a sweep can surface pid-class ghosts the binding store cannot represent.
export function readLifecycleGuardWakeField(
  now: Date = new Date(),
  paths?: { storePath?: string; feedPath?: string },
): LifecycleGuardWakeField {
  const storeField = tryReadStoreField(
    paths?.storePath ?? lifecycleGuardStorePath(),
    now.getTime(),
  );
  const feedField = tryReadFeedField(paths?.feedPath ?? lifecycleGuardFeedPath());
  if (storeField?.orphanedSessions && storeField.orphanedSessions.length > 0) {
    return storeField;
  }
  if (feedField?.orphanedSessions && feedField.orphanedSessions.length > 0) {
    return feedField;
  }
  if (storeField) return storeField;
  if (feedField) return feedField;
  return { orphanedSessions: null, orphanedSessionsTruncated: false, source: "none" };
}

// Append one run_end record for a Paperclip run boundary. Idempotent on
// (parentRunId, endedAt): a repeated identical boundary is a no-op and a conflicting
// endedAt never overwrites the first recorded boundary (first wins, matching the core
// store semantics). Best-effort: unreachable stores degrade to a reported reason.
export function appendLifecycleGuardRunEnd(input: {
  parentRunId: string;
  endedAt: string;
  ts?: string;
  storePath?: string;
}): LifecycleGuardRunEndResult {
  const parentRunId =
    typeof input.parentRunId === "string" ? input.parentRunId.trim() : "";
  const endedAt = typeof input.endedAt === "string" ? input.endedAt.trim() : "";
  if (!parentRunId || !endedAt || Number.isNaN(Date.parse(endedAt))) {
    return { appended: false, reason: "invalid_input" };
  }
  const storePath = input.storePath ?? lifecycleGuardStorePath();
  let existing: Array<Record<string, unknown>> = [];
  try {
    existing = readRecordLines(storePath);
  } catch {
    // A missing store is an empty store for dedupe purposes; the append below
    // decides availability.
  }
  for (const record of existing) {
    if (record.type !== "run_end") continue;
    if (record.parentRunId !== parentRunId) continue;
    if (record.endedAt === endedAt) {
      return { appended: false, reason: "idempotent" };
    }
    return { appended: false, reason: "conflicting_run_end" };
  }
  try {
    const line = JSON.stringify({
      type: "run_end",
      ts: input.ts ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      parentRunId,
      endedAt,
    });
    appendFileSync(storePath, line + "\n", { encoding: "utf8" });
    return { appended: true, reason: "recorded" };
  } catch {
    return { appended: false, reason: "store_unavailable" };
  }
}
