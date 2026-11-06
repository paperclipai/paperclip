import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { stagePrivateDiagnostics } from "./private-diagnostics.js";
import { prepareSourceServerDependencies } from "./source-startup.js";
import { copyRetainedSourceSdk, retainPreparedSourceSdk } from "./source-sdk-evidence.js";

const roots: string[] = [], executionId = "chat-features.runner-opencode.local.plugins.install-plugin", sourceRevision = "a".repeat(40);
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
  await mkdir(path.join(temporaryRoot, "selected-private-inputs"), { recursive: true, mode: 0o700 });
  stagePrivateDiagnostics(temporaryRoot, [executionId], secrets);
  const input = { repositoryRoot, temporaryRoot, executionIds: [executionId], sourceRevision, installed: false };
  const prepare = (environment: NodeJS.ProcessEnv = {}) => prepareSourceServerDependencies(repositoryRoot, environment, false, { temporaryRoot, executionIds: [executionId], sourceRevision });
  return { root, repositoryRoot, temporaryRoot, uploadDir, input, prepare };
}

it("initializes owned SDK staging before retention when private capture is outside the temporary root", async () => {
  const f = await fixture();
  const externalCapture = path.join(f.root, "manual-handoff", "capture");
  await mkdir(externalCapture, { recursive: true, mode: 0o700 });
  await f.prepare();
  const staged = path.join(f.temporaryRoot, "artifacts-private");
  expect((await stat(staged)).mode & 0o777).toBe(0o700);
  const receipt = JSON.parse(await readFile(path.join(staged, "source-sdk-build/receipt.json"), "utf8"));
  expect(receipt).toMatchObject({ executionId, sourceRevision });
  expect(receipt.certifiedTargets).toHaveLength(2);
  await expect(copyRetainedSourceSdk(f.temporaryRoot, executionId, sourceRevision, f.uploadDir, [])).resolves.toBeUndefined();
  await expect(stat(path.join(externalCapture, "source-sdk-build"))).rejects.toThrow();
});
it("rejects a symlink SDK staging parent without writing retained evidence outside the attempt", async () => {
  const f = await fixture();
  const outside = path.join(f.root, "outside");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, path.join(f.temporaryRoot, "artifacts-private"));
  await expect(f.prepare()).rejects.toThrow("Source SDK staging custody invalid");
  await expect(stat(path.join(outside, "source-sdk-build"))).rejects.toThrow();
});
it("still rejects changed certified output after staging initialization", async () => {
  const f = await fixture(); await f.prepare();
  await rm(path.join(f.temporaryRoot, "artifacts-private/source-sdk-build"), { recursive: true });
  await writeFile(path.join(f.repositoryRoot, "packages/plugins/sdk/dist/index.js"), "changed compiler bytes");
  await expect(retainPreparedSourceSdk(f.input)).rejects.toThrow("no longer matches");
  await expect(stat(path.join(f.temporaryRoot, "artifacts-private/source-sdk-build"))).rejects.toThrow();
});
it.each(["missing redaction registry", "credential contamination", "compiler failure"])("does not retain evidence for %s after staging initialization", async invalid => {
  const f = await fixture(["synthetic-private-upstream-credential-value"]);
  if (invalid === "missing redaction registry") await rm(path.join(f.temporaryRoot, "selected-private-inputs/diagnostic-redaction.json"));
  await expect(f.prepare(invalid === "credential contamination" ? { SYNTHETIC_OUTPUT_CONTENT: "synthetic-private-upstream-credential-value" }
    : invalid === "compiler failure" ? { FAIL_COMPILER: "1" } : {})).rejects.toThrow();
  await expect(stat(path.join(f.temporaryRoot, "artifacts-private/source-sdk-build"))).rejects.toThrow();
});
