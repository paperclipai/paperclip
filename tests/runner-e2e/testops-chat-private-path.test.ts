import { afterEach, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { authorizeManualPrivateEvidence, MANUAL_PRIVATE_EXECUTIONS, MANUAL_PRIVATE_PROTOCOL, manualCellKind, manualPrivateSessionPolicy } from "./manual-private-retention.js";
import { canonicalGeneratedReportAsset, cellTraceAsset, inspectCellReportProducer, privateCellEvidenceOwner } from "./manual-private-report-assets.js";

const id = "chat-features.runner-opencode-deepseek-1017.local.create-backlog";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it.each(["cell-read", "cell-write", "report-write"] as const)("keeps the shipped chat %s session scoped to only its existing private archive", mode => {
  const policy = manualPrivateSessionPolicy({ bucket: "private-evidence", runId: "123", executionIds: [id], mode });
  const objects = policy.Statement.filter(row => Array.isArray(row.Resource)).flatMap(row => row.Resource);
  const filename = mode === "report-write" ? "manual-report" : manualCellKind(id);
  const key = `arn:aws:s3:::private-evidence/runner-e2e-private/bounded-v1/campaigns/gha-123-1/${filename}.zip`;
  expect(objects).toEqual([key, `${key}.upload-receipt.json`]);
  expect(JSON.stringify(policy)).not.toContain("*");
  expect(() => manualPrivateSessionPolicy({ bucket: "private-evidence", runId: "123", executionIds: [id.replace("create-backlog", "delegate-announcement")], mode })).toThrow();
});
it("preserves the frozen244 candidate approval registry and refuses shipped authority through that old authorizer", () => {
  expect(MANUAL_PRIVATE_EXECUTIONS).toHaveLength(244);
  expect(MANUAL_PRIVATE_EXECUTIONS).not.toContain(id);
  const identity = { workflowSha: "a".repeat(40), targetSha: "b".repeat(40), runId: "123", attempt: "1", executionIds: [id] };
  expect(() => authorizeManualPrivateEvidence(identity, JSON.stringify({ version: 1, approvals: [{ ...identity, protocol: MANUAL_PRIVATE_PROTOCOL, launchSha256: "c".repeat(64) }] }))).toThrow("Unsupported private manual evidence selection");
});
it("binds canonical private trace assets to the exact shipped profile and rejects a rewritten profile or sibling case", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "testops-private-path-"))); roots.push(root);
  const context = { root, private: true as const, runId: "123", attempt: "1", executionIds: [id], cellReportProducer: await inspectCellReportProducer() };
  const owner = await privateCellEvidenceOwner(context, id);
  const prefix = `gha-123-1-${id}/chat-features/runner-opencode-deepseek-1017/local/create-backlog/attempt-1/html-report/trace/`;
  expect(cellTraceAsset(`${prefix}playwright-logo.svg`, owner, "final")).toEqual({ reserved: true, canonical: canonicalGeneratedReportAsset("html/trace/playwright-logo.svg") });
  expect(cellTraceAsset(`${prefix.replace("/runner-opencode-deepseek-1017/", "/runner-opencode/")}playwright-logo.svg`, owner, "final")).toEqual({ reserved: true, canonical: undefined });
  for (const foreign of [id.replace("create-backlog", "delegate-announcement"), id.replace("deepseek-1017", "unknown")]) {
    await expect(privateCellEvidenceOwner({ ...context, executionIds: [foreign] }, foreign)).rejects.toThrow("Invalid private cell report owner");
  }
});
