import { createHash } from "node:crypto";
import { canonicalNativeJson, nativeSha256 } from "../../native-runtime/canonical.js";

export const RESULT_TEXT_KEYS = ["summary", "result", "message", "text", "output", "content", "body"];

export function withoutActionResults(value: unknown, actionRequestIds: ReadonlySet<string>): { value: unknown; changed: boolean } {
  let changed = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) next[key] = walk(entry);
    if (typeof record.actionRequestId === "string" && actionRequestIds.has(record.actionRequestId)
      && typeof record.resultSummary === "string" && record.resultSummary !== "") {
      next.resultSummary = "";
      changed = true;
    }
    return next;
  };
  const result = walk(value);
  return { value: changed ? result : value, changed };
}

export function withoutResultText(value: Record<string, unknown> | null): { value: Record<string, unknown> | null; changed: boolean } {
  if (!value || typeof value !== "object") return { value, changed: false };
  let changed = false;
  const walk = (node: unknown, topLevel: boolean): unknown => {
    if (Array.isArray(node)) return node.map((entry) => walk(entry, false));
    if (!node || typeof node !== "object") return node;
    if ((node as Record<string, unknown>).schema === "paperclip.run_result.v1") return node;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      if (RESULT_TEXT_KEYS.includes(key) && typeof entry === "string") {
        if (entry !== "") changed = true;
        if (!topLevel) next[key] = "";
        else if (entry === "") next[key] = entry;
        continue;
      }
      next[key] = walk(entry, false);
    }
    return next;
  };
  const next = walk(value, true) as Record<string, unknown>;
  return { value: changed ? next : value, changed };
}

const STRUCTURAL_KEYS = new Set(["schema", "kind", "status", "type", "outcome", "state", "version", "code", "id", "reportedWorkDisposition"]);
const TERMINAL_SCHEMA = "paperclip.prp.terminal.v1";
export const DELETED_TEXT = "Removed because the connection data was deleted.";
export const CHECKPOINT_CONTENT_DELETED_MARKER = "contentDeletedAt";
const RUN_RESULT_SCHEMA = "paperclip.run_result.v1";
const HASHED_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const RUN_RESULT_KEPT_PATHS = new Set([
  "schema",
  "reportedWorkDisposition",
  "completionClaim.contractRevision",
  "completionClaim.criteria.status",
  "verification.status",
  "verification.reasonCode",
  "blocker.owner.kind",
  "blocker.scope",
  "attentionRequests.ownerClass",
  "continuation.kind",
]);
const RUN_RESULT_HASHED_PATHS = new Set([
  "completionClaim.criteria.criterionId",
  "attentionRequests.targetAgentId",
  "continuation.idempotencyKey",
  "continuation.handoffId",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hashedText(value: string): string {
  return HASHED_FINGERPRINT.test(value) ? value : `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function deletedText(value: string): string {
  return value === "" ? value : DELETED_TEXT;
}

function withoutRunResultText(value: unknown, path = ""): unknown {
  if (typeof value === "string") {
    if (RUN_RESULT_KEPT_PATHS.has(path)) return value;
    if (RUN_RESULT_HASHED_PATHS.has(path)) return hashedText(value);
    return deletedText(value);
  }
  if (Array.isArray(value)) return value.map((entry) => withoutRunResultText(entry, path));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withoutRunResultText(entry, path ? `${path}.${key}` : key)]));
  }
  return value;
}

export function withoutAllText(value: unknown, key = ""): unknown {
  if (typeof value === "string") return /At$/.test(key) ? value : deletedText(value);
  if (Array.isArray(value)) return value.map((entry) => withoutAllText(entry, key));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, withoutAllText(entry, entryKey)]));
  return value;
}

export function withoutFreeText(value: unknown, key = ""): unknown {
  if (typeof value === "string") return STRUCTURAL_KEYS.has(key) || /(Id|At)$/.test(key) ? value : deletedText(value);
  if (Array.isArray(value)) return value.map((entry) => withoutFreeText(entry, key));
  if (isRecord(value)) {
    if (value.schema === RUN_RESULT_SCHEMA) return withoutRunResultText(value);
    if (value.schema === TERMINAL_SCHEMA) return value;
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, withoutFreeText(entry, entryKey)]));
  }
  return value;
}

function hashedFingerprint(value: unknown): unknown {
  return typeof value === "string" ? hashedText(value) : value;
}

export function withoutRunAnswers(value: Record<string, unknown> | null): { value: Record<string, unknown> | null; changed: boolean } {
  if (!isRecord(value)) return { value, changed: false };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isRecord(node)) return node;
    if (node.schema === RUN_RESULT_SCHEMA) return withoutRunResultText(node);
    return Object.fromEntries(Object.entries(node).map(([key, entry]) => [key, walk(entry)]));
  };
  const next = walk(value) as Record<string, unknown>;
  const changed = canonicalNativeJson(next) !== canonicalNativeJson(value);
  return { value: changed ? next : value, changed };
}

export function withoutCheckpointAnswers(profile: Record<string, unknown> | null): { value: Record<string, unknown> | null; changed: boolean } {
  if (!isRecord(profile) || !isRecord(profile.sessionCheckpoint)) return { value: profile, changed: false };
  const checkpoint = profile.sessionCheckpoint;
  const nextCheckpoint = { ...(withoutRunAnswers(checkpoint).value as Record<string, unknown>) };
  if (isRecord(nextCheckpoint.semanticResult) && "fingerprint" in nextCheckpoint.semanticResult) {
    nextCheckpoint.semanticResult = { ...nextCheckpoint.semanticResult, fingerprint: hashedFingerprint(nextCheckpoint.semanticResult.fingerprint) };
  }
  if (Array.isArray(nextCheckpoint.terminalTurns)) {
    nextCheckpoint.terminalTurns = nextCheckpoint.terminalTurns.map((turn) => isRecord(turn) ? { ...turn, fingerprint: hashedFingerprint(turn.fingerprint) } : turn);
  }
  if (isRecord(nextCheckpoint.governedWait) && isRecord(nextCheckpoint.governedWait.sourceEvent)) {
    const sourceEvent = nextCheckpoint.governedWait.sourceEvent;
    nextCheckpoint.governedWait = { ...nextCheckpoint.governedWait, sourceEvent: { ...sourceEvent, payload: withoutAllText(sourceEvent.payload) } };
  }
  if (typeof nextCheckpoint[CHECKPOINT_CONTENT_DELETED_MARKER] !== "string") nextCheckpoint[CHECKPOINT_CONTENT_DELETED_MARKER] = new Date().toISOString();
  if (canonicalNativeJson(nextCheckpoint) === canonicalNativeJson(checkpoint)) return { value: profile, changed: false };
  const next: Record<string, unknown> = { ...profile, sessionCheckpoint: nextCheckpoint };
  const recovery = profile.nativeControllerRecovery;
  if (isRecord(recovery) && recovery.snapshotSha256 === nativeSha256(checkpoint)) {
    next.nativeControllerRecovery = { ...recovery, snapshotSha256: nativeSha256(nextCheckpoint) };
  }
  return { value: next, changed: true };
}

export function checkpointProfileForRun(contentDeletedAt: string | null | undefined, profile: Record<string, unknown>): Record<string, unknown> {
  if (!contentDeletedAt) return profile;
  return withoutCheckpointAnswers(profile).value ?? profile;
}
