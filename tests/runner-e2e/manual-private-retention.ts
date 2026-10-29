import { createHash } from "node:crypto";

export const MANUAL_PRIVATE_PROTOCOL = "paperclip.manual-private-evidence/v1";
export const MANUAL_PRIVATE_EXECUTIONS = Object.freeze([
  "activity.agent-feedback", "activity.work-timeline", "companies.import-preview",
  "navigation-preferences.dismiss-announcement", "tasks.completion-with-gate",
  "tasks.private-task", "secrets.personal-secret", "agents.choose-primary",
].map(id => `chat-features.runner-opencode.local.${id}`));
const sha = /^[0-9a-f]{40}$/;
const execution = /^[A-Za-z0-9][A-Za-z0-9._-]{0,249}$/;
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join() === [...expected].sort().join();
}
export function canonicalManualIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 32
    || value.some(id => typeof id !== "string" || !execution.test(id)) || new Set(value).size !== value.length)
    throw new Error("Invalid exact manual evidence selection");
  return [...value].sort();
}
export function requiresPrivateManualEvidence(id: string) {
  return id === "chat-features" || id.startsWith("chat-features.");
}
export interface ManualRetentionIdentity {
  workflowSha: string; targetSha: string; runId: string; attempt: string; executionIds: string[];
}
export function authorizeManualPrivateEvidence(identity: ManualRetentionIdentity, approvalJson: string) {
  if (!sha.test(identity.workflowSha) || !sha.test(identity.targetSha) || !/^[1-9][0-9]{0,19}$/.test(identity.runId) || identity.attempt !== "1")
    throw new Error("Invalid manual private evidence identity");
  const ids = canonicalManualIds(identity.executionIds);
  if (ids.some(id => !MANUAL_PRIVATE_EXECUTIONS.includes(id))) throw new Error("Unsupported private manual evidence selection");
  if (Buffer.byteLength(approvalJson) > 65536) throw new Error("Invalid protected manual evidence approval");
  let policy: unknown;
  try { policy = JSON.parse(approvalJson); } catch { throw new Error("Invalid protected manual evidence approval"); }
  if (!keys(policy, ["version", "approvals"]) || policy.version !== 1 || !Array.isArray(policy.approvals) || policy.approvals.length > 32)
    throw new Error("Invalid protected manual evidence approval");
  const matches = policy.approvals.filter(row => {
    if (!keys(row, ["workflowSha", "targetSha", "runId", "attempt", "executionIds", "protocol", "launchSha256"]) || !sha.test(String(row.workflowSha))
      || !sha.test(String(row.targetSha)) || !/^[1-9][0-9]{0,19}$/.test(String(row.runId)) || row.attempt !== "1" || row.protocol !== MANUAL_PRIVATE_PROTOCOL || !/^[0-9a-f]{64}$/.test(String(row.launchSha256)))
      throw new Error("Invalid protected manual evidence approval");
    const selected = canonicalManualIds(row.executionIds);
    return row.workflowSha === identity.workflowSha && row.targetSha === identity.targetSha && row.runId === identity.runId && row.attempt === identity.attempt && selected.join() === ids.join();
  });
  if (matches.length !== 1) throw new Error("Exact protected manual evidence approval missing or ambiguous");
  return Object.freeze({ ...identity, executionIds: Object.freeze(ids), protocol: MANUAL_PRIVATE_PROTOCOL,
    launchSha256: String(matches[0]!.launchSha256), approvalSha256: createHash("sha256").update(approvalJson).digest("hex"), private: true as const });
}
export function manualCellKind(id: string) {
  if (!execution.test(id)) throw new Error("Invalid manual evidence execution identity");
  return `manual-cell-${createHash("sha256").update(id).digest("hex")}`;
}
export function manualPrivateSessionPolicy(input: { bucket: string; runId: string; executionIds: string[]; mode: "cell-write" | "cell-read" | "report-write" }) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket) || !/^[1-9][0-9]{0,19}$/.test(input.runId))
    throw new Error("Invalid manual private storage identity");
  const ids = canonicalManualIds(input.executionIds);
  if (ids.some(id => !MANUAL_PRIVATE_EXECUTIONS.includes(id)) || input.mode !== "report-write" && ids.length !== 1)
    throw new Error("Private archive sessions require one exact cell or the report writer");
  const prefix = `arn:aws:s3:::${input.bucket}/runner-e2e-private/bounded-v1/campaigns/gha-${input.runId}-1/`;
  const cells = ids.map(id => `${prefix}${manualCellKind(id)}.zip`);
  const policy = { Version: "2012-10-17", Statement: [
    { Effect: "Allow", Action: ["s3:GetBucketVersioning", "s3:GetLifecycleConfiguration", "s3:GetBucketObjectLockConfiguration", "s3:GetReplicationConfiguration", "s3:GetBucketPublicAccessBlock", "s3:GetBucketOwnershipControls", "s3:GetBucketPolicy"], Resource: `arn:aws:s3:::${input.bucket}` },
    ...(input.mode === "cell-read" ? [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: cells.flatMap(key => [key, `${key}.upload-receipt.json`]) }] : []),
    ...(input.mode === "cell-read" ? [] : [{ Effect: "Allow", Action: ["s3:PutObject"], Resource: (input.mode === "report-write" ? [`${prefix}manual-report.zip`] : cells).flatMap(key => [key, `${key}.upload-receipt.json`]) }]),
  ] };
  if (JSON.stringify(policy).length > 2048) throw new Error("Private archive session policy exceeds the STS limit");
  return policy;
}
