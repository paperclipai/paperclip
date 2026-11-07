import { expect, it } from "vitest";
import type { FeedbackTraceBundle } from "../../../packages/shared/src/types/feedback.js";
import { validInstalledReceipt } from "./privileged-installed.js";
import { gradeInstalledUpdate } from "./privileged-update.js";
import { gradeProvisionRuntime } from "./privileged-provision.js";
import { gradeOwnedDev, validOwnedDevResult } from "./privileged-owned-dev.js";
import { gradeFeedbackBundle, interruptedBundleMatches, storedArchiveEntries } from "./privileged-feedback.js";
const base = { scenarioId: "owned", origin: "http://owned.invalid", companyId: "company", leadId: "lead", state: {}, tasks: [], projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [], links: [], humanQueries: ["canonical"], runs: [], reply: "" };
it("requires explicit disposable published artifact and full dependency-tree pins", () => {
  const r = { schemaVersion: 1 as const, disposable: true as const, cli: "/owned/prefix/lib/node_modules/paperclipai/dist/index.js", cliSha256: "a".repeat(64), server: "/owned/server/dist/index.js", serverSha256: "b".repeat(64), installationTreeSha256: "c".repeat(64), serverPid: 123, version: "2026.1026.1", targetVersion: "2026.1026.2", targetIntegrity: "sha512-YWJjZA==" };
  expect(validInstalledReceipt(r)).toBe(true);
  for (const delta of [{ installationTreeSha256: "" }, { serverPid: 0 }, { targetVersion: "latest" }, { targetIntegrity: "unpinned" }]) expect(validInstalledReceipt({ ...r, ...delta })).toBe(false);
});
it("rejects download-only update proof, wrong service version and premature assistant success", () => {
  const state = { installMode: "global-npm", registryIntegrityMatched: true, updateExecuted: true, installedVersion: "2.0.0", targetVersion: "2.0.0", healthVersion: "2.0.0", healthReady: true, serviceRestarted: true, finalCliSha256: "f".repeat(64), rollbackVersion: "1.0.0", originalVersion: "1.0.0", guidance: "The terminal operator should inspect the npm installation channel first.", updateReport: { attributed: true, reply: "The receipt shows 2.0.0 after restart and healthy readiness." } };
  expect(gradeInstalledUpdate({ ...base, state }).passed).toBe(true);
  for (const delta of [{ updateExecuted: false }, { healthVersion: "1.0.0" }, { registryIntegrityMatched: false }, { rollbackVersion: "unknown" }, { guidance: "I have updated to the newest version." }, { updateReport: { attributed: false, reply: state.updateReport.reply } }]) expect(gradeInstalledUpdate({ ...base, state: { ...state, ...delta } }).passed).toBe(false);
});
it("does not qualify Pi from provisioner/download evidence without a separate genuine native task", () => {
  const state = { assetsInitiallyAbsent: true, provisionerSucceeded: true, provisionerSha256: "a".repeat(64), nativeClosureSha256: "b".repeat(64), releaseVersion: "1.0.0", healthVersion: "1.0.0", assetPathOwned: true, piAgentConfigurationVerified: true, piRunId: "pi-run", piAgentId: "pi", piArtifactMatches: true, guidance: "The operator can run runtime setup pi in the terminal.", provisionReport: { attributed: true, reply: "Pi completed a real native qualification run." } };
  const runs = [{ id: "initial", agentId: "lead", status: "succeeded" }, { id: "pi-run", agentId: "pi", status: "succeeded", runtimeMode: "native" }, { id: "report", agentId: "lead", status: "succeeded" }];
  expect(gradeProvisionRuntime({ ...base, state, runs }).passed).toBe(true);
  for (const delta of [{ piArtifactMatches: false }, { piAgentConfigurationVerified: false }, { assetPathOwned: false }, { healthVersion: "other" }]) expect(gradeProvisionRuntime({ ...base, state: { ...state, ...delta }, runs }).passed).toBe(false);
  expect(gradeProvisionRuntime({ ...base, state, runs: runs.filter(r => r.id !== "pi-run") }).passed).toBe(false);
});
it("requires actual seed readback, source/unrelated preservation and exact target cleanup", () => {
  const state = { sourceCanaryUnchanged: true, targetCanaryMatches: true, actualTargetHealthy: true, targetStopped: true, targetCleaned: true, unrelatedSentinelUnchanged: true, sourceRevisionPinned: true, targetUrl: "http://127.0.0.1:54321", sourceCliMatches: true, guidance: "The operator can use worktree commands in the owned checkout.", devReport: { attributed: true, reply: "http://127.0.0.1:54321 was healthy and is now stopped and cleaned." } };
  expect(validOwnedDevResult(state)).toBe(true); expect(gradeOwnedDev({ ...base, state }).passed).toBe(true);
  for (const key of ["sourceCanaryUnchanged", "targetCanaryMatches", "actualTargetHealthy", "targetStopped", "targetCleaned", "unrelatedSentinelUnchanged", "sourceCliMatches"]) expect(gradeOwnedDev({ ...base, state: { ...state, [key]: false } }).passed).toBe(false);
});
it("binds retained interrupted work to actual original cancelled run, comment and events", () => {
  const run = { id: "run", companyId: "company", agentId: "morgan", status: "cancelled", eventCount: 1 };
  const bundle: FeedbackTraceBundle = { traceId: "trace", exportId: null, issueIdentifier: "OWN-1", adapterType: "paperclip_runner", captureStatus: "partial", notes: [], surface: null, rawAdapterTrace: null, normalizedAdapterTrace: null, privacy: null, integrity: {}, companyId: "company", issueId: "task", envelope: { targetId: "comment" }, paperclipRun: run, files: [{ path: "paperclip/run.json", contentType: "application/json", encoding: "utf8", byteLength: 1, sha256: "x", source: "paperclip_run", contents: JSON.stringify(run) }, { path: "paperclip/run-events.json", contentType: "application/json", encoding: "utf8", byteLength: 1, sha256: "x", source: "paperclip_run_events", contents: JSON.stringify([{ runId: "run", seq: 1 }]) }] };
  const ids = { company: "company", issue: "task", run: "run", agent: "morgan", comment: "comment" };
  expect(interruptedBundleMatches(bundle, ids)).toBe(true);
  expect(interruptedBundleMatches({ ...bundle, paperclipRun: { ...run, status: "failed" } }, ids)).toBe(false);
  expect(interruptedBundleMatches(bundle, { ...ids, comment: "other" })).toBe(false);
  expect(interruptedBundleMatches({ ...bundle, files: bundle.files.slice(0, 1) }, ids)).toBe(false);
});
it("requires actual private scoped bundle bytes and truthful local interruption report", () => {
  const state = { agentReportStatus: 403, cliExecuted: true, workerWasReallyWaiting: true, cancelledBeforeCanonical: true, exportedInterruptionMatches: true, workerRunId: "run", originalTraceUnchanged: true, bundleWithinOwnedDirectory: true, exportCompanyMatches: true, exportIssueMatches: true, fullTraceBytesMatch: true, archiveBytesMatch: true, zipSha256: "a".repeat(64), zipBytes: 100, noPrivateCredentialBytes: true, remoteSharingUnchanged: true, bundlePublished: false, localOutputDirectory: "/owned/export", exportReport: { attributed: true, reply: "The local feedback and trace/events bundle is at /owned/export and retains the cancelled interrupted work." } };
  const runs = [{ id: "run", status: "cancelled" }];
  expect(gradeFeedbackBundle({ ...base, state, runs }).passed).toBe(true);
  for (const delta of [{ agentReportStatus: 200 }, { archiveBytesMatch: false }, { remoteSharingUnchanged: false }, { noPrivateCredentialBytes: false }, { exportedInterruptionMatches: false }, { exportReport: { attributed: true, reply: "Published failed native model failure evidence at /owned/export." } }]) expect(gradeFeedbackBundle({ ...base, state: { ...state, ...delta }, runs }).passed).toBe(false);
});
it("rejects arbitrary, truncated or path-escaping archive bytes", () => {
  expect(() => storedArchiveEntries(Buffer.from("not zip"))).toThrow();
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(5, 26); const bytes = Buffer.concat([header, Buffer.from("../xx"), Buffer.from([0x50, 0x4b, 0x01, 0x02])]);
  expect(() => storedArchiveEntries(bytes)).toThrow();
});
