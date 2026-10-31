import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sealPreframeworkOperation, validatePreframeworkOperation, type PrivatePreframeworkOperation } from "./manual-private-operation.js";
import { preparePrivateCellBundle, verifyDownloadedPrivateCell } from "./manual-private-transfer.js";
import { STEERING_PI_EXECUTION, STEERING_PI_PROFILE, STEERING_PI_SOURCE_CLOSURE } from "./steering-pi-receipt.js";
import { sealStandardOriginalEvidence, sealManualResultEvidence, type ManualPrivateHandoff } from "./manual-private-handoff.js";
import { packageEvidence } from "./evidence.js";
import { MANUAL_PRIVATE_PROTOCOL, manualCellKind } from "./manual-private-retention.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
 const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "preframework-operation-")); roots.push(root);
 const context = { root, protocol: MANUAL_PRIVATE_PROTOCOL, private: true, workflowSha: "a".repeat(40), targetSha: "b".repeat(40), runId: "123", attempt: "1", executionIds: [STEERING_PI_EXECUTION] } as ManualPrivateHandoff;
 const operation: PrivatePreframeworkOperation = { schema: "paperclip.private-preframework-operation/v1", kind: "steering-pi-installation", frameworkStarted: false, runtimeFingerprint: null,
  executionId: STEERING_PI_EXECUTION, runId: context.runId, attempt: "1", workflowSha: context.workflowSha, targetSha: context.targetSha,
  profileVersion: 30, profileDigest: STEERING_PI_PROFILE.digest, sourceClosureSha256: STEERING_PI_SOURCE_CLOSURE,
  buildArtifact: `runner-e2e-build-${context.targetSha}-123-1`, buildSha256: "c".repeat(64), provisionerSha256: "d".repeat(64),
  phase: "installer", outcome: "unknown", retirement: "unknown", outputCapture: "unknown", capturedStreams: ["stdout", "stderr"] };
 const save = () => writeFile(path.join(root, "steering-pi-operation.json"), JSON.stringify(operation), { mode: 0o600 }); await save();
 await writeFile(path.join(root, "steering-pi-installer.stdout.log"), "synthetic package progress\n", { mode: 0o600 });
 await writeFile(path.join(root, "steering-pi-installer.stderr.log"), "synthetic download failure\n", { mode: 0o600 });
 return { root, context, operation, save };
}
it("actual original sealer/bundle/download admit a private zero-result unknown-retirement operation", async () => {
 const f = await fixture(); const sealed = await sealPreframeworkOperation(f.context, []);
 expect(sealed.requiredEvidenceComplete).toBe(null); expect(sealed.files.map(r => r.path)).toEqual(["playwright-output/steering-pi-installer.stderr.log", "playwright-output/steering-pi-installer.stdout.log", "snapshots/preframework-operation.json"]);
 const { bundle } = await preparePrivateCellBundle(f.root, STEERING_PI_EXECUTION, f.context, "preframework-operation");
 const identity = JSON.parse(await readFile(path.join(bundle, "identity.json"), "utf8"));
 expect(identity.operation.frameworkStarted).toBe(false); expect(identity.operation.runtimeFingerprint).toBe(null);
 const verified = await verifyDownloadedPrivateCell(bundle, STEERING_PI_EXECUTION, identity);
 expect(verified.operation?.outcome).toBe("unknown"); expect(verified.operation?.retirement).toBe("unknown"); expect(verified.operation?.outputCapture).toBe("unknown");
 expect(await readFile(path.join(bundle, "originals", manualCellKind(STEERING_PI_EXECUTION), "playwright-output/steering-pi-installer.stderr.log"), "utf8")).toBe("synthetic download failure\n");
 await expect(readFile(path.join(bundle, "sealed-results/result.json"))).rejects.toThrow();
});
it("ordinary cells without sealed results still reject and operation archives cannot masquerade as cells", async () => {
 const f = await fixture(); await sealPreframeworkOperation(f.context, []);
 await expect(preparePrivateCellBundle(f.root, STEERING_PI_EXECUTION, f.context)).rejects.toThrow("Operation cannot");
 const g = await fixture(), source = path.join(g.root, "ordinary-source"); await mkdir(path.join(source, "snapshots"), { recursive: true, mode: 0o700 });
 await writeFile(path.join(source, "snapshots/diagnostic.json"), '{"stage":"setup"}', { mode: 0o600 });
 const scan = await packageEvidence({ privateDir: source, uploadDir: path.join(g.root, "ordinary-scan"), secrets: [], expectPassScreenshot: false });
 await sealStandardOriginalEvidence({ context: g.context, executionId: STEERING_PI_EXECUTION, source, evidence: scan, secrets: [], expectPassScreenshot: false });
 await expect(preparePrivateCellBundle(g.root, STEERING_PI_EXECUTION, g.context)).rejects.toThrow(/ENOENT/);
});
it("rejects true framework, wrong source/run/profile, unknown schema and invented runtime identity", async () => {
 const f = await fixture();
 for (const change of [{ frameworkStarted: true }, { runId: "456" }, { targetSha: "e".repeat(40) }, { profileVersion: 35 }, { profileDigest: "sha256:9473de6ef4baf2bd82fe8b6757239bdc160960b0a78ae6f47fa9e0996544226c" }, { runtimeFingerprint: "invented" }, { outcome: "verified" }, { extra: true }, { capturedStreams: ["stdout"] }])
  expect(() => validatePreframeworkOperation({ ...f.operation, ...change }, f.context)).toThrow();
});
it("rejects mixed real framework storage on the operation path", async () => {
 const f = await fixture(); await sealPreframeworkOperation(f.context, []); await mkdir(path.join(f.root, "results"));
 await expect(preparePrivateCellBundle(f.root, STEERING_PI_EXECUTION, f.context, "preframework-operation")).rejects.toThrow("mixed framework");
});
it("rejects extra or symlink operation carriers through actual seal/transfer checks", async () => {
 const f = await fixture(); await sealPreframeworkOperation(f.context, []);
 const original = path.join(f.root, "originals", manualCellKind(STEERING_PI_EXECUTION));
 await writeFile(path.join(original, "snapshots/extra.json"), "{}", { mode: 0o600 });
 await expect(preparePrivateCellBundle(f.root, STEERING_PI_EXECUTION, f.context, "preframework-operation")).rejects.toThrow();
 const g = await fixture(); await rm(path.join(g.root, "steering-pi-installer.stderr.log")); await symlink(path.join(g.root, "steering-pi-installer.stdout.log"), path.join(g.root, "steering-pi-installer.stderr.log"));
 await expect(sealPreframeworkOperation(g.context, [])).rejects.toThrow();
});
it("unchanged exact/encoded/provider-shape scans remain fatal before any private bundle", async () => {
 const f = await fixture(); await writeFile(path.join(f.root, "steering-pi-installer.stdout.log"), "synthetic-registered-secret-123456");
 await expect(sealPreframeworkOperation(f.context, ["synthetic-registered-secret-123456"])).rejects.toThrow();
 const g = await fixture(); await writeFile(path.join(g.root, "steering-pi-installer.stderr.log"), "sk-or-v1-" + "a".repeat(64));
 await expect(sealPreframeworkOperation(g.context, [])).rejects.toThrow();
});
it("seals an admission failure before target reader or installer ever ran", async () => {
 const f = await fixture(); Object.assign(f.operation, { phase: "admission", outcome: "failed", retirement: "not-started", capturedStreams: [], provisionerSha256: null }); await f.save();
 await rm(path.join(f.root, "steering-pi-installer.stdout.log")); await rm(path.join(f.root, "steering-pi-installer.stderr.log"));
 const scan = await sealPreframeworkOperation(f.context, []); expect(scan.files.map(r => r.path)).toEqual(["snapshots/preframework-operation.json"]);
 const { bundle } = await preparePrivateCellBundle(f.root, STEERING_PI_EXECUTION, f.context, "preframework-operation");
 const identity = JSON.parse(await readFile(path.join(bundle, "identity.json"), "utf8")); expect((await verifyDownloadedPrivateCell(bundle, STEERING_PI_EXECUTION, identity)).operation?.retirement).toBe("not-started");
});

it("download rejects added outer archive files as well as wrong operation identity", async () => {
 const f = await fixture(); await sealPreframeworkOperation(f.context, []); const { bundle } = await preparePrivateCellBundle(f.root, STEERING_PI_EXECUTION, f.context, "preframework-operation");
 const identity = JSON.parse(await readFile(path.join(bundle, "identity.json"), "utf8"));
 await expect(verifyDownloadedPrivateCell(bundle, STEERING_PI_EXECUTION, { ...identity, operation: { ...identity.operation, runId: "456" } })).rejects.toThrow();
 await writeFile(path.join(bundle, "extra.log"), "not scanned"); await expect(verifyDownloadedPrivateCell(bundle, STEERING_PI_EXECUTION, identity)).rejects.toThrow("Unexpected private operation archive carrier");
});

it("the trusted failure owner records an import/admission failure with no target reader or case result", async () => {
 const f = await fixture(); await rm(path.join(f.root, "steering-pi-operation.json"));
 await rm(path.join(f.root, "steering-pi-installer.stdout.log")); await rm(path.join(f.root, "steering-pi-installer.stderr.log"));
 await sealPreframeworkOperation(f.context, []); const { bundle } = await preparePrivateCellBundle(f.root, STEERING_PI_EXECUTION, f.context, "preframework-operation");
 const identity = JSON.parse(await readFile(path.join(bundle, "identity.json"), "utf8"));
 expect(identity.operation).toMatchObject({ frameworkStarted: false, runtimeFingerprint: null, phase: "admission", outcome: "unknown", retirement: "not-started", capturedStreams: [], buildSha256: null });
});

it("ordinary sealed framework FAIL evidence still bundles and downloads without an operation", async () => {
 const f = await fixture(), source = path.join(f.root, "ordinary"); await mkdir(path.join(source, "snapshots"), { recursive: true, mode: 0o700 });
 await writeFile(path.join(source, "result.json"), '{"status":"failed"}', { mode: 0o600 });
 const scan = await packageEvidence({ privateDir: source, uploadDir: path.join(f.root, "ordinary-scan"), secrets: [], expectPassScreenshot: false });
 await sealStandardOriginalEvidence({ context: f.context, executionId: STEERING_PI_EXECUTION, source, evidence: scan, secrets: [], expectPassScreenshot: false });
 await mkdir(path.join(f.root, "results"), { mode: 0o700 }); await writeFile(path.join(f.root, "results/campaign.json"), '{"status":"failed"}', { mode: 0o600 });
 await sealManualResultEvidence(f.context, []);
 const { bundle } = await preparePrivateCellBundle(f.root, STEERING_PI_EXECUTION, f.context);
 const identity = JSON.parse(await readFile(path.join(bundle, "identity.json"), "utf8"));
 expect((await verifyDownloadedPrivateCell(bundle, STEERING_PI_EXECUTION, identity)).operation).toBeUndefined();
 expect(await readFile(path.join(bundle, "sealed-results/html-report/campaign.json"), "utf8")).toBe('{"status":"failed"}');
});

it("rejects known output omitted by an existing admission state before creating any inventory", async () => {
 const f = await fixture(); Object.assign(f.operation, { phase: "admission", outcome: "failed", retirement: "not-started", capturedStreams: [], provisionerSha256: null }); await f.save();
 const secret = "synthetic-known-output-root-123456"; await writeFile(path.join(f.root, "steering-pi-installer.stdout.log"), secret);
 await expect(sealPreframeworkOperation(f.context, [secret])).rejects.toThrow();
 await expect(readFile(path.join(f.root, "originals", manualCellKind(STEERING_PI_EXECUTION), "original-evidence-inventory.json"))).rejects.toThrow(/ENOENT/);
});
