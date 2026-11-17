import { expect, it } from "vitest";
import { authorizeManualPrivateEvidence, canonicalManualIds, MAX_MANUAL_PRIVATE_CELLS, MANUAL_PRIVATE_EXECUTIONS, MANUAL_PRIVATE_PROTOCOL, manualCellKind, manualPrivateSessionPolicy, requiresPrivateManualEvidence } from "./manual-private-retention.js";
const workflowSha = "a".repeat(40), targetSha = "b".repeat(40);
const identity = { workflowSha, targetSha, runId: "123", attempt: "1", executionIds: [MANUAL_PRIVATE_EXECUTIONS[0]!] };
const approval = () => ({ version: 1, approvals: [{ workflowSha, targetSha, runId: "123", attempt: "1", executionIds: identity.executionIds, protocol: MANUAL_PRIVATE_PROTOCOL, launchSha256: "c".repeat(64) }] });
it("requires exact protected workflow, target and selected IDs for the first supported manual scope", () => {
  expect(authorizeManualPrivateEvidence(identity, JSON.stringify(approval()))).toMatchObject({ private: true, protocol: MANUAL_PRIVATE_PROTOCOL });
});
it.each(["chat-features.runner-opencode.local.activity.agent-feedback", "chat-features.runner-codex.local.unknown", "chat-features"])("classification of %s cannot be downgraded by a target flag", id => expect(requiresPrivateManualEvidence(id)).toBe(true));
it.each(["workflow", "target", "ids", "protocol", "extra", "duplicate", "empty", "rerun", "wrong-run"])("rejects %s approval mismatch without granting a role", kind => {
 const p = approval(); const i = { ...identity };
 if (kind === "workflow") p.approvals[0]!.workflowSha = "c".repeat(40);
 if (kind === "target") p.approvals[0]!.targetSha = "c".repeat(40);
 if (kind === "ids") p.approvals[0]!.executionIds = [MANUAL_PRIVATE_EXECUTIONS[1]!];
 if (kind === "protocol") p.approvals[0]!.protocol = "unknown";
 if (kind === "extra") Object.assign(p.approvals[0]!, { private: true });
 if (kind === "duplicate") p.approvals.push(p.approvals[0]!);
 if (kind === "empty") p.approvals = [];
 if (kind === "rerun") i.attempt = "2";
 if (kind === "wrong-run") p.approvals[0]!.runId = "124";
 expect(() => authorizeManualPrivateEvidence(i, JSON.stringify(p))).toThrow();
});
it("unknown and mixed manual cases cannot acquire private role authority", () => {
 expect(() => authorizeManualPrivateEvidence({ ...identity, executionIds: ["chat-features.runner-opencode.local.onboarding.future-unknown"] }, JSON.stringify(approval()))).toThrow();
 expect(() => authorizeManualPrivateEvidence({ ...identity, executionIds: [...identity.executionIds, "runner.native.local.other"] }, JSON.stringify(approval()))).toThrow();
});
it("different cells have distinct immutable private object identities", () => {
 expect(manualCellKind(MANUAL_PRIVATE_EXECUTIONS[0]!)).not.toBe(manualCellKind(MANUAL_PRIVATE_EXECUTIONS[1]!));
 expect(() => manualCellKind("../escape")).toThrow();
});
it("vetted paid transfer session is put-only and the trusted report reads only selected current cells", () => {
 const paid = manualPrivateSessionPolicy({ bucket: "private-evidence", runId: "123", executionIds: identity.executionIds, mode: "cell-write" });
 expect(paid.Statement.flatMap(s => s.Action)).not.toContain("s3:GetObject");
 const report = manualPrivateSessionPolicy({ bucket: "private-evidence", runId: "123", executionIds: identity.executionIds, mode: "cell-read" });
 const reads = report.Statement.find(s => s.Action.includes("s3:GetObject"))!;
 expect(reads.Resource).toEqual([`arn:aws:s3:::private-evidence/runner-e2e-private/bounded-v1/campaigns/gha-123-1/${manualCellKind(identity.executionIds[0]!)}.zip`, `arn:aws:s3:::private-evidence/runner-e2e-private/bounded-v1/campaigns/gha-123-1/${manualCellKind(identity.executionIds[0]!)}.zip.upload-receipt.json`]);
 expect(JSON.stringify(report)).not.toContain("gha-124");
});
it("the supported private archive kind is collision-free and rejects arbitrary manual paths", async () => {
 const { privateArtifactKey } = await import("./private-history.js");
 expect(privateArtifactKey(manualCellKind(identity.executionIds[0]!), "123")).toContain("/manual-cell-");
 expect(privateArtifactKey("manual-report", "123")).toMatch(/manual-report\.zip$/);
 expect(() => privateArtifactKey("manual-cell-../escape", "123")).toThrow();
});

it("keeps the full-eight report inline session policy within STS's 2048-character limit",()=>{
 const policy=manualPrivateSessionPolicy({bucket:"b".repeat(63),runId:"12345678901234567890",executionIds:MANUAL_PRIVATE_EXECUTIONS.slice(0, 8),mode:"report-write"});
 expect(JSON.stringify(policy).length).toBeLessThanOrEqual(2048);
});

it("all244 exact read/write cell scopes fit STS and never broaden to other cells or wildcards",()=>{
 for(const id of MANUAL_PRIVATE_EXECUTIONS)for(const mode of ["cell-read","cell-write"]as const){
  const p=manualPrivateSessionPolicy({bucket:"b".repeat(63),runId:"12345678901234567890",executionIds:[id],mode});
  expect(JSON.stringify(p).length).toBeLessThanOrEqual(2048);expect(JSON.stringify(p)).not.toContain("*");
  const objects=p.Statement.filter(s=>Array.isArray(s.Resource)).flatMap(s=>s.Resource);expect(objects).toHaveLength(2);
  expect(objects.every(r=>r.includes(manualCellKind(id)))).toBe(true);
 }
 expect(()=>manualPrivateSessionPolicy({bucket:"private-bucket",runId:"123",executionIds:[...MANUAL_PRIVATE_EXECUTIONS],mode:"cell-read"})).toThrow();
});

const enrolled = ["access.invite-teammate", "activity.routine-audit"].map(id => `chat-features.runner-opencode.local.${id}`);
function approvedSelection(ids: string[]) {
 return { version: 1, approvals: [{ ...approval().approvals[0]!, executionIds: ids }] };
}
it("the full frozen registry preserves exact run authority while a private run remains bounded to eight", () => {
 expect(MANUAL_PRIVATE_EXECUTIONS).toHaveLength(244);
 expect(new Set(MANUAL_PRIVATE_EXECUTIONS).size).toBe(244);
 expect(MAX_MANUAL_PRIVATE_CELLS).toBe(8);
 for (const ids of [...enrolled.map(id => [id]), MANUAL_PRIVATE_EXECUTIONS.slice(0, 8)]) {
  expect(authorizeManualPrivateEvidence({ ...identity, executionIds: ids }, JSON.stringify(approvedSelection(ids))).executionIds).toEqual([...ids].sort());
 }
 expect(canonicalManualIds(Array.from({ length: 32 }, (_, i) => `ordinary-${i}`))).toHaveLength(32);
});
it.each([9, 10])("enrollment rejects %s private cells at identity, every approval row and session boundaries", count => {
 const ids = MANUAL_PRIVATE_EXECUTIONS.slice(0, count);
 expect(() => authorizeManualPrivateEvidence({ ...identity, executionIds: ids }, JSON.stringify(approvedSelection(ids)))).toThrow();
 const policy = approval();
 policy.approvals.push({ ...policy.approvals[0]!, runId: "124", executionIds: ids });
 expect(() => authorizeManualPrivateEvidence(identity, JSON.stringify(policy))).toThrow();
 for (const mode of ["report-write", "cell-read", "cell-write"] as const)
  expect(() => manualPrivateSessionPolicy({ bucket: "private-bucket", runId: "123", executionIds: ids, mode })).toThrow();
});

it("full catalog requires exact original-run approval for each registered execution", () => {
 for (const id of MANUAL_PRIVATE_EXECUTIONS) {
  const selected = [id];
  expect(authorizeManualPrivateEvidence({ ...identity, executionIds: selected }, JSON.stringify(approvedSelection(selected))).executionIds).toEqual(selected);
  expect(() => authorizeManualPrivateEvidence({ ...identity, runId: "124", executionIds: selected }, JSON.stringify(approvedSelection(selected)))).toThrow();
 }
 const duplicate = [MANUAL_PRIVATE_EXECUTIONS[0]!, MANUAL_PRIVATE_EXECUTIONS[0]!];
 expect(() => authorizeManualPrivateEvidence({ ...identity, executionIds: duplicate }, JSON.stringify(approvedSelection(duplicate)))).toThrow();
});
