import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { stagePrivateDiagnostics } from "./private-diagnostics.js";
import { prepareSourceServerDependencies } from "./source-startup.js";
import { copyRetainedSourceSdk, retainPreparedSourceSdk, SOURCE_SDK_DIAGNOSTICS } from "./source-sdk-evidence.js";
import { packageEvidence } from "./evidence.js";
import { isHistoricalBundlePathAllowed } from "./history-publish.js";

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
  await put("node_modules/typescript/bin/tsc", `const fs=require('node:fs'),path=require('node:path');if(process.env.FAIL_COMPILER==='1')process.exit(7);const dir=path.join(path.dirname(process.argv[3]),'dist');fs.mkdirSync(path.join(dir,'nested'),{recursive:true});fs.writeFileSync(path.join(dir,'index.js'),process.env.SYNTHETIC_OUTPUT_CONTENT||'export const syntheticFixture = true;\\n');fs.writeFileSync(path.join(dir,'nested/child.js'),'export {};\\n');`);
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
