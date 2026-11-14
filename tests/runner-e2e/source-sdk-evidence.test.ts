import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { prepareReviewedSdkReference } from "./source-sdk-reviewed-fixture.js";
import pins from "./source-sdk-public-inputs.json" with { type: "json" };
import { afterEach, expect, it } from "vitest";
import { stagePrivateDiagnostics } from "./private-diagnostics.js";
import { prepareSourceServerDependencies } from "./source-startup.js";
import { copyRetainedSourceSdk, retainPreparedSourceSdk, SOURCE_SDK_DIAGNOSTICS } from "./source-sdk-evidence.js";
import { packageEvidence } from "./evidence.js";
import { isHistoricalBundlePathAllowed } from "./history-publish.js";
import { sealManualResultEvidence, type ManualPrivateHandoff } from "./manual-private-handoff.js";
import { MANUAL_PRIVATE_EXECUTIONS, MANUAL_PRIVATE_PROTOCOL } from "./manual-private-retention.js";

const roots: string[] = [], executionId = "chat-features.runner-opencode.local.plugins.install-plugin", sourceRevision = "a".repeat(40);
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(secrets: string[] = []) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "source-sdk-synthetic-unit-"))); roots.push(root);
  const repositoryRoot = path.join(root, "repo"), temporaryRoot = path.join(root, "attempt"), uploadDir = path.join(root, "uploaded");
  const put = async (file: string, value: string | Buffer) => { await mkdir(path.dirname(path.join(repositoryRoot, file)), { recursive: true }); await writeFile(path.join(repositoryRoot, file), value); };
  await put("scripts/ensure-plugin-build-deps.mjs", await readFile(new URL("../../scripts/ensure-plugin-build-deps.mjs", import.meta.url)));
  await put("pnpm-lock.yaml", "synthetic unit lock\n");
  for (const directory of ["packages/shared", "packages/plugins/sdk"]) {
    await put(`${directory}/src/index.ts`, "export const syntheticFixture = true;\n"); await put(`${directory}/tsconfig.json`, "{}");
  }
  await put("node_modules/typescript/bin/tsc", `const fs=require('node:fs'),path=require('node:path');if(process.env.FAIL_COMPILER==='1')process.exit(7);const dir=path.join(path.dirname(process.argv[3]),'dist');fs.mkdirSync(path.join(dir,'nested'),{recursive:true});fs.writeFileSync(path.join(dir,'index.js'),process.env.SYNTHETIC_OUTPUT_CONTENT||'export const syntheticFixture = true;\\n');fs.writeFileSync(path.join(dir,'nested/child.js'),'export {};\\n');fs.writeFileSync(path.join(dir,'index.d.ts'),'export declare const syntheticFixture: boolean;\\n');fs.writeFileSync(path.join(dir,'index.js.map'),'{"version":3}\\n');`);
  await mkdir(path.join(temporaryRoot, "artifacts-private"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(temporaryRoot, "selected-private-inputs"), { recursive: true, mode: 0o700 });
  stagePrivateDiagnostics(temporaryRoot, [executionId], secrets);
  const input = { repositoryRoot, temporaryRoot, executionIds: [executionId], sourceRevision, installed: false };
  const prepare = (environment: NodeJS.ProcessEnv = {}) => prepareSourceServerDependencies(repositoryRoot, environment, false, { temporaryRoot, executionIds: [executionId], sourceRevision });
  return { root, repositoryRoot, temporaryRoot, uploadDir, input, prepare };
}

it.each([true, false])("retains exact synthetic compiler output before admission and survives normal packaging/cleanup (pass=%s)", async pass => {
  const f = await fixture();
  await expect(readFile(path.join(f.repositoryRoot, "packages/plugins/sdk/dist/index.js"))).rejects.toThrow();
  await f.prepare();
  const receipt = JSON.parse(await readFile(path.join(f.temporaryRoot, "artifacts-private/source-sdk-build/receipt.json"), "utf8"));
  expect(receipt).toMatchObject({ schema: "paperclip.source-plugin-sdk/v1", executionId, sourceRevision }); expect(receipt.certifiedTargets).toHaveLength(2);
  expect(receipt.buildHelperSha256).toBe(hash(await readFile(path.join(f.repositoryRoot, "scripts/ensure-plugin-build-deps.mjs"))));
  const packaged = await packageEvidence({ privateDir: path.join(f.temporaryRoot, "case"), uploadDir: f.uploadDir, secrets: [], expectPassScreenshot: pass });
  expect(packaged.leaks).toEqual([]);
  await copyRetainedSourceSdk(f.temporaryRoot, executionId, sourceRevision, f.uploadDir, []);
  const bounded = path.join(f.root, "bounded");
  await promisify(execFile)(process.execPath, [new URL("./artifact-budget.mjs", import.meta.url).pathname, "stage", "evidence", f.uploadDir, bounded]);
  await rm(f.temporaryRoot, { recursive: true });
  for (const file of receipt.files) {
    const retained = path.join(f.uploadDir, SOURCE_SDK_DIAGNOSTICS, file.retainedPath);
    expect(hash(await readFile(retained))).toBe(file.sha256); expect((await stat(retained)).mode & 0o777).toBe(0o600);
    expect(file.retainedSha256).toBe(file.sha256);
    expect(hash(await readFile(path.join(bounded, SOURCE_SDK_DIAGNOSTICS, file.retainedPath)))).toBe(file.sha256);
    expect(isHistoricalBundlePathAllowed(`evidence/${executionId}/attempt-1/${SOURCE_SDK_DIAGNOSTICS}/${file.retainedPath}`, true)).toBe(false);
  }
  expect(isHistoricalBundlePathAllowed(`evidence/${executionId}/attempt-1/${SOURCE_SDK_DIAGNOSTICS}/receipt.json`, true)).toBe(false);
});
it("cannot retain output before existing helper certification or after compilation failure; never rebuilds during packaging", async () => {
  const f = await fixture();
  await expect(retainPreparedSourceSdk(f.input)).rejects.toThrow();
  await expect(f.prepare({ FAIL_COMPILER: "1" })).rejects.toMatchObject({ code: 7 });
  await expect(readFile(path.join(f.temporaryRoot, "artifacts-private/source-sdk-build/receipt.json"))).rejects.toThrow();
  await expect(copyRetainedSourceSdk(f.temporaryRoot, executionId, sourceRevision, f.uploadDir, [])).rejects.toThrow();
  await expect(readFile(path.join(f.repositoryRoot, "packages/plugins/sdk/dist/index.js"))).rejects.toThrow();
});
it("rejects output changed after certification instead of copying a stale completion marker", async () => {
  const f = await fixture(); await f.prepare();
  await rm(path.join(f.temporaryRoot, "artifacts-private/source-sdk-build"), { recursive: true });
  await writeFile(path.join(f.repositoryRoot, "packages/plugins/sdk/dist/index.js"), "changed after certification");
  await expect(retainPreparedSourceSdk(f.input)).rejects.toThrow("no longer matches");
  await expect(stat(path.join(f.temporaryRoot, "artifacts-private/source-sdk-build"))).rejects.toThrow();
});
it("requires the existing owned redaction registry before retaining compiled bytes", async () => {
  const f = await fixture(); await rm(path.join(f.temporaryRoot, "selected-private-inputs/diagnostic-redaction.json"));
  await expect(f.prepare()).rejects.toThrow();
  await expect(stat(path.join(f.temporaryRoot, "artifacts-private/source-sdk-build"))).rejects.toThrow();
});
it.each(["raw", "base64"])("refuses registered %s credential bytes before any retention write", async encoding => {
  const secret = "synthetic-private-upstream-credential-value", f = await fixture([secret]);
  const value = encoding === "base64" ? Buffer.from(secret).toString("base64") : secret;
  await expect(f.prepare({ SYNTHETIC_OUTPUT_CONTENT: value })).rejects.toThrow("privacy check failed");
  await expect(stat(path.join(f.temporaryRoot, "artifacts-private/source-sdk-build"))).rejects.toThrow();
});
it.each(["wrong source", "wrong selected case", "tampered bytes", "new secret", "symlink"])("fails closed for %s in retained custody", async invalid => {
  const f = await fixture(); await f.prepare();
  const staged = path.join(f.temporaryRoot, "artifacts-private/source-sdk-build"), file = path.join(staged, "packages/plugins/sdk/dist/index.js");
  if (invalid === "tampered bytes") await writeFile(file, "changed compiler bytes");
  if (invalid === "symlink") { await rm(file); await symlink(path.join(f.repositoryRoot, "packages/plugins/sdk/dist/index.js"), file); }
  await expect(copyRetainedSourceSdk(f.temporaryRoot, invalid === "wrong selected case" ? "chat-features.runner-opencode.local.plugins.configure-plugin" : executionId,
    invalid === "wrong source" ? "b".repeat(40) : sourceRevision, f.uploadDir, invalid === "new secret" ? ["syntheticFixture"] : [])).rejects.toThrow();
});
it("ordinary/multi-cell/installed lanes do not retain or require SDK evidence", async () => {
  const f = await fixture();
  for (const changed of [{ executionIds: ["chat-features.runner-opencode.local.tasks.website-task"] }, { executionIds: [executionId, executionId] }, { installed: true }])
    await expect(retainPreparedSourceSdk({ ...f.input, ...changed })).resolves.toBeUndefined();
  await expect(copyRetainedSourceSdk(f.temporaryRoot, "unselected", null, f.uploadDir, [])).resolves.toBeUndefined();
  await expect(stat(path.join(f.temporaryRoot, "artifacts-private/source-sdk-build"))).rejects.toThrow();
});
it("retains declarations and source maps under names the private result sealer admits", async () => {
  const f = await fixture(); await f.prepare();
  const receipt = JSON.parse(await readFile(path.join(f.temporaryRoot, "artifacts-private/source-sdk-build/receipt.json"), "utf8"));
  expect(receipt.files.map((row: { retainedPath: string }) => row.retainedPath)).toEqual(expect.arrayContaining(["packages/shared/dist/index.d.ts.txt", "packages/shared/dist/index.js.map.txt", "packages/shared/dist/index.js"]));
  // Built SDK output always contains .d.ts and .map files. Sealing the results
  // tree used to reject them as unsupported carriers and lose the whole attempt.
  const context = { root: f.root, protocol: MANUAL_PRIVATE_PROTOCOL, private: true, workflowSha: "a".repeat(40), targetSha: "b".repeat(40), runId: "123", attempt: "1", executionIds: [MANUAL_PRIVATE_EXECUTIONS[0]!] } as ManualPrivateHandoff;
  const results = path.join(f.root, "results"), uploadDir = path.join(results, "campaign", "attempt-1");
  await copyRetainedSourceSdk(f.temporaryRoot, executionId, sourceRevision, uploadDir, []);
  for (const file of receipt.files) expect(hash(await readFile(path.join(uploadDir, SOURCE_SDK_DIAGNOSTICS, file.retainedPath)))).toBe(file.sha256);
  await expect(sealManualResultEvidence(context, [], results)).resolves.not.toThrow();
});
// Build a genuine OWN normal producer-certified reviewed reference. The live
// CI lock can be regenerated for unrelated PR patches and must not be relabeled reviewed.
const builtSdk = ["packages/shared/dist", "packages/plugins/sdk/dist"].every(target =>
  existsSync(new URL(`../../${target}/.paperclip-build-complete`, import.meta.url)));
it("seals a normal producer-certified reviewed-reference SDK, keeping key-shaped declarations out", async () => {
  const originalRoot=await realpath(path.resolve(import.meta.dirname,"../.."));
  const repositoryRoot=await realpath(await mkdtemp(path.join(os.tmpdir(),"source-sdk-reviewed-build-")));roots.push(repositoryRoot);
  await prepareReviewedSdkReference(originalRoot,repositoryRoot);
  // Existing normal Shared then SDK producer, exact original configs/options.
  // Fresh dist directories and OWN cache/Shared resolution; no donor outputs.
  expect(existsSync(path.join(repositoryRoot,"packages/shared/dist"))).toBe(false);
  expect(existsSync(path.join(repositoryRoot,"packages/plugins/sdk/dist"))).toBe(false);
  await prepareSourceServerDependencies(repositoryRoot,{...process.env},false);
  for(const directory of ["packages/shared/dist","packages/plugins/sdk/dist"]){
    expect(await realpath(path.join(repositoryRoot,directory))).toBe(path.join(repositoryRoot,directory));
    expect(JSON.parse(await readFile(path.join(repositoryRoot,directory,".paperclip-build-complete"),"utf8")))
      .toMatchObject({sources:expect.stringMatching(/^[a-f0-9]{64}$/),outputs:expect.stringMatching(/^[a-f0-9]{64}$/)});
  }
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "source-sdk-real-unit-"))); roots.push(root);
  const temporaryRoot = path.join(root, "attempt"), results = path.join(root, "results"), uploadDir = path.join(results, "campaign", "attempt-1");
  await mkdir(path.join(temporaryRoot, "artifacts-private"), { recursive: true, mode: 0o700 }); await mkdir(path.join(temporaryRoot, "selected-private-inputs"), { recursive: true, mode: 0o700 });
  const secrets = ["synthetic-unit-provider-credential-0123456789"]; stagePrivateDiagnostics(temporaryRoot, [executionId], secrets);
  await retainPreparedSourceSdk({ repositoryRoot, temporaryRoot, executionIds: [executionId], sourceRevision, installed: false });
  await copyRetainedSourceSdk(temporaryRoot, executionId, sourceRevision, uploadDir, secrets, repositoryRoot);
  await expect(stat(path.join(uploadDir, SOURCE_SDK_DIAGNOSTICS, "packages/shared/dist/validators/agent.d.ts.txt"))).rejects.toThrow();
  await expect(stat(path.join(uploadDir, SOURCE_SDK_DIAGNOSTICS, "packages/shared/dist/validators/agent.js"))).resolves.toBeTruthy();
  const context = { root, protocol: MANUAL_PRIVATE_PROTOCOL, private: true, workflowSha: "a".repeat(40), targetSha: "b".repeat(40), runId: "123", attempt: "1", executionIds: [MANUAL_PRIVATE_EXECUTIONS[0]!] } as ManualPrivateHandoff;
  await expect(sealManualResultEvidence(context, secrets, results)).resolves.not.toThrow();
}, 120_000);

it("withholds real unreviewed-build SDK bytes instead of authenticating the CI-resolved lock",async()=>{
  const originalRoot=await realpath(path.resolve(import.meta.dirname,"../.."));
  let repositoryRoot=originalRoot,restoreLock:(()=>Promise<void>)|undefined;
  const actual=await readFile(path.join(originalRoot,"pnpm-lock.yaml"));
  if(hash(actual)===pins.lockSha256){
    // On a reviewed local checkout, make the same refusal observable in an
    // OWN genuine-built reference by invalidating only its owning lock input.
    repositoryRoot=await realpath(await mkdtemp(path.join(os.tmpdir(),"source-sdk-unreviewed-build-")));roots.push(repositoryRoot);
    await prepareReviewedSdkReference(originalRoot,repositoryRoot);
    await prepareSourceServerDependencies(repositoryRoot,{...process.env},false);
    const file=path.join(repositoryRoot,"pnpm-lock.yaml"),reviewed=await readFile(file);
    await writeFile(file,Buffer.concat([reviewed,Buffer.from("\n# unreviewed unit input mutation\n")]));
    restoreLock=()=>writeFile(file,reviewed);
  }else if(!builtSdk)throw new Error("Unreviewed CI build requires its actual normal producer outputs");
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"source-sdk-unreviewed-refusal-")));roots.push(root);
  const temporaryRoot=path.join(root,"attempt");
  await mkdir(path.join(temporaryRoot,"selected-private-inputs"),{recursive:true,mode:0o700});
  stagePrivateDiagnostics(temporaryRoot,[executionId],["synthetic-unit-provider-credential-0123456789"]);
  try{
    await expect(retainPreparedSourceSdk({repositoryRoot,temporaryRoot,executionIds:[executionId],sourceRevision,installed:false}))
      .rejects.toThrow("Source SDK evidence privacy check failed; bytes withheld");
    const file=path.join(temporaryRoot,"artifacts-private/cases/plugins.install-plugin/snapshots/source-sdk-privacy-observations.json");
    const observation=JSON.parse(await readFile(file,"utf8"));
    expect(observation.complete).toBe(false);expect(observation.audit.publicSource).toBeNull();
    expect(observation.audit.bounded).toBe(true);expect(observation.audit.suppressedFindings).toBe(0);
    expect(observation.audit.observations).toEqual(expect.arrayContaining([expect.objectContaining({
      pathSha256:hash("packages/shared/dist/validators/agent.d.ts"),detector:3,classification:"unresolved_context"})]));
    await expect(stat(path.join(temporaryRoot,"artifacts-private/source-sdk-build/receipt.json"))).rejects.toThrow();
    await expect(stat(path.join(temporaryRoot,"artifacts-private/source-sdk-build/packages"))).rejects.toThrow();
  }finally{await restoreLock?.();}
},120_000);
