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

const STRUCTURAL_KEYS = new Set(["schema", "kind", "status", "type", "outcome", "state", "version", "code", "id", "reportedWorkDisposition", "reasonCode", "ownerClass"]);
const RUN_RESULT_SCHEMA = "paperclip.run_result.v1";
const HASHED_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function withoutFreeText(value: unknown, key = ""): unknown {
  if (typeof value === "string") return STRUCTURAL_KEYS.has(key) || /(Id|At)$/.test(key) ? value : "";
  if (Array.isArray(value)) return value.map((entry) => withoutFreeText(entry, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [entryKey, withoutFreeText(entry, entryKey)]));
  }
  return value;
}

function hashedFingerprint(value: unknown): unknown {
  if (typeof value !== "string" || HASHED_FINGERPRINT.test(value)) return value;
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function withoutRunAnswers(value: Record<string, unknown> | null): { value: Record<string, unknown> | null; changed: boolean } {
  if (!isRecord(value)) return { value, changed: false };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isRecord(node)) return node;
    if (node.schema === RUN_RESULT_SCHEMA) return withoutFreeText(node);
    return Object.fromEntries(Object.entries(node).map(([key, entry]) => [key, walk(entry)]));
  };
  const next = walk(value) as Record<string, unknown>;
  const changed = canonicalNativeJson(next) !== canonicalNativeJson(value);
  return { value: changed ? next : value, changed };
}

export function withoutCheckpointAnswers(profile: Record<string, unknown> | null): { value: Record<string, unknown> | null; changed: boolean } {
  if (!isRecord(profile) || !isRecord(profile.sessionCheckpoint)) return { value: profile, changed: false };
  const checkpoint = profile.sessionCheckpoint;
  const nextCheckpoint: Record<string, unknown> = { ...checkpoint };
  if (isRecord(checkpoint.semanticResult)) {
    nextCheckpoint.semanticResult = {
      ...checkpoint.semanticResult,
      result: withoutFreeText(checkpoint.semanticResult.result),
      fingerprint: hashedFingerprint(checkpoint.semanticResult.fingerprint),
    };
  }
  if (Array.isArray(checkpoint.terminalTurns)) {
    nextCheckpoint.terminalTurns = checkpoint.terminalTurns.map((turn) => isRecord(turn) ? { ...turn, fingerprint: hashedFingerprint(turn.fingerprint) } : turn);
  }
  if (canonicalNativeJson(nextCheckpoint) === canonicalNativeJson(checkpoint)) return { value: profile, changed: false };
  const next: Record<string, unknown> = { ...profile, sessionCheckpoint: nextCheckpoint };
  const recovery = profile.nativeControllerRecovery;
  if (isRecord(recovery) && recovery.snapshotSha256 === nativeSha256(checkpoint)) {
    next.nativeControllerRecovery = { ...recovery, snapshotSha256: nativeSha256(nextCheckpoint) };
  }
  return { value: next, changed: true };
}
