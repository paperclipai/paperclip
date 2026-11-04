import type { ManualPrivateHandoff } from "./manual-private-handoff.js";
import { afterAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { copyPrivateFrameworkReport, inspectPrivateFrameworkMetadata, PRIVATE_FRAMEWORK_ORIGINAL_REPORT, PRIVATE_FRAMEWORK_REPORT, referenceSealedFrameworkAttachments, validatePrivateFrameworkReport } from "./private-framework-report.js";
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "framework-json-control-")); roots.push(root);
  const source = path.join(root, "capture"), cell = path.join(source, "cases/activity.agent-feedback"), output = path.join(source, "playwright-output/owned");
  await mkdir(cell, { recursive: true }); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "trace.zip"), "synthetic canonical trace");
  const report = { config: { version: "1.62.1" }, errors: [], suites: [{ specs: [{ tests: [{ results: [{ status: "failed", error: { message: "actual failure" }, errors: [{ message: "actual failure" }], stdout: [], stderr: [], steps: [{ title: "owned failed step", error: { message: "actual failure" } }], attachments: [{ name: "trace", contentType: "application/zip", path: path.join(output, "trace.zip") }] }] }] }], suites: [] }] };
  await writeFile(path.join(source, "framework-report.json"), JSON.stringify(report));
  await cp(path.join(source, "playwright-output"), path.join(cell, "playwright-output"), { recursive: true });
  return { root, source, cell, report };
}
it("keeps official failed status/errors/steps and binds one canonical attachment across original and result trees", async () => {
  const f = await fixture(); await writeFile(path.join(f.cell, "playwright-output/unregistered.log"), "unexplained evidence retained"); await copyPrivateFrameworkReport(f.source, f.cell, []);
  const value = await validatePrivateFrameworkReport(f.cell);
  expect((value.report.suites as any)[0].specs[0].tests[0].results[0]).toMatchObject({ status: "failed", error: { message: "actual failure" }, steps: [{ title: "owned failed step" }] });
  const original = path.join(f.root, "original"); await cp(f.cell, original, { recursive: true });
  await referenceSealedFrameworkAttachments(f.cell, original, "owned");
  await expect(readFile(path.join(f.cell, "playwright-output/owned/trace.zip"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(f.cell, "playwright-output/unregistered.log"), "utf8")).toBe("unexplained evidence retained");
  expect(await readFile(path.join(original, "playwright-output/owned/trace.zip"), "utf8")).toBe("synthetic canonical trace");
  await expect(validatePrivateFrameworkReport(f.cell, original, "owned")).resolves.toMatchObject({ canonicalExecutionId: "owned" });
  await expect(validatePrivateFrameworkReport(f.cell, original, "foreign")).rejects.toThrow();
  await writeFile(path.join(original, "playwright-output/owned/trace.zip"), "tampered");
  await expect(validatePrivateFrameworkReport(f.cell, original, "owned")).rejects.toThrow();
});
it.each(["empty", "malformed", "foreign", "missing", "secret", "body-secret", "foreign-version", "unknown-status"])("refuses %s framework evidence", async kind => {
  const f = await fixture();
  if (kind === "foreign-version") f.report.config.version = "0.0.0";
  if (kind === "unknown-status") f.report.suites[0]!.specs[0]!.tests[0]!.results[0]!.status = "invented";
  if (kind === "empty") f.report.suites = [];
  if (kind === "foreign") f.report.suites[0]!.specs[0]!.tests[0]!.results[0]!.attachments[0]!.path = path.join(f.root, "outside.zip");
  if (kind === "missing") await rm(path.join(f.cell, "playwright-output/owned/trace.zip"));
  if (kind === "secret") f.report.errors = [{ message: "synthetic-private-credential" }] as any;
  if (kind === "body-secret") (f.report.suites[0]!.specs[0]!.tests[0]!.results[0]!.attachments[0] as any).body = Buffer.from("synthetic-private-credential").toString("base64");
  await writeFile(path.join(f.source, "framework-report.json"), kind === "malformed" ? "{" : JSON.stringify(f.report));
  await expect(copyPrivateFrameworkReport(f.source, f.cell, ["synthetic-private-credential"])).rejects.toThrow();
});
it("uses the real official Playwright JSON producer with failed errors, user steps, and automatic trace", async () => {
  const f = await fixture(), tests = path.join(f.root, "tests"); await mkdir(tests);
  const require = createRequire(import.meta.url), pkg = require.resolve("@playwright/test/package.json"), entry = require.resolve("@playwright/test");
  await writeFile(path.join(tests, "failed.spec.cjs"), `const {test,expect}=require(${JSON.stringify(entry)});test('original failed result',async()=>{await test.step('owned failed step',async()=>expect('actual').toBe('expected'));});`);
  const config = path.join(tests, "config.cjs");
  await writeFile(config, `module.exports=${JSON.stringify({ testDir: tests, testMatch: "failed.spec.cjs", workers: 1, outputDir: path.join(f.source, "playwright-output"), use: { trace: "retain-on-failure" }, reporter: [["json", { outputFile: path.join(f.source, "framework-report.json") }]] })};`);
  await promisify(execFile)(process.execPath, [path.join(path.dirname(pkg), "cli.js"), "test", "--config", config], { cwd: tests, env: { PATH: process.env.PATH, CI: "1", NODE_OPTIONS: "", NODE_PATH: "" }, timeout: 30000 }).then(() => { throw new Error("Original should fail"); }, error => { expect(error.code).toBe(1); });
  await rm(path.join(f.cell, "playwright-output"), { recursive: true });
  await cp(path.join(f.source, "playwright-output"), path.join(f.cell, "playwright-output"), { recursive: true });
  await copyPrivateFrameworkReport(f.source, f.cell, []);
  const retained = await validatePrivateFrameworkReport(f.cell), result = (retained.report.suites as any)[0].specs[0].tests[0].results[0];
  expect(result.status).toBe("failed"); expect(result.errors.length).toBeGreaterThan(0); expect(result.steps[0].title).toBe("owned failed step");
  expect(retained.attachments.some(a => a.path.endsWith("/trace.zip"))).toBe(true);
});
it("keeps the unchanged 256MiB packaging/archive caps with one canonical large attachment", async () => {
  const { packageEvidence } = await import("./evidence.js");
  const { inspectCellReportProducer, privateCellEvidenceOwner } = await import("./manual-private-report-assets.js");
  const { archivePrivateEvidence } = await import("./private-history.js");
  const { sealStandardOriginalEvidence, sealManualResultEvidence } = await import("./manual-private-handoff.js");
  const { validateSealedOriginals, validateSealedInventory } = await import("./manual-private-transfer.js");
  const { MANUAL_PRIVATE_PROTOCOL, manualCellKind } = await import("./manual-private-retention.js");
  const f = await fixture(), id = "chat-features.runner-opencode.local.activity.agent-feedback";
  const context: ManualPrivateHandoff = { root: await (await import("node:fs/promises")).realpath(f.root), private: true as const, protocol: MANUAL_PRIVATE_PROTOCOL,
    runId: "123", attempt: "1", workflowSha: "a".repeat(40), targetSha: "b".repeat(40), executionIds: [id], cellReportProducer: await inspectCellReportProducer() };
  const zip = path.join(f.root, "input.zip");
  await promisify(execFile)("python3", ["-c", "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_STORED);f=z.open('synthetic.trace','w');[f.write(b'0'*1048576) for _ in range(140)];f.close();z.close()", zip], { timeout: 30000 });
  const tests = path.join(f.root, "budget-tests"); await mkdir(tests);
  const require = createRequire(import.meta.url), pkg = require.resolve("@playwright/test/package.json"), entry = require.resolve("@playwright/test");
  await writeFile(path.join(tests, "failed.spec.cjs"), `const {test,expect}=require(${JSON.stringify(entry)});test('owned failed large attachment',async({},info)=>{await info.attach('owned trace',{path:${JSON.stringify(zip)},contentType:'application/zip'});await test.step('actual failed assertion',async()=>expect(1).toBe(2));});`);
  const config = path.join(tests, "config.cjs");
  await writeFile(config, `module.exports=${JSON.stringify({ testDir: tests, testMatch: "failed.spec.cjs", workers: 1, use: { trace: "retain-on-failure" }, outputDir: path.join(f.source, "playwright-output"), reporter: [["json", { outputFile: path.join(f.source, "framework-report.json") }], ["html", { outputFolder: path.join(f.source, "html-report"), open: "never" }], ["blob", { outputDir: path.join(f.source, "blob-report") }]] })};`);
  await promisify(execFile)(process.execPath, [path.join(path.dirname(pkg), "cli.js"), "test", "--config", config], { cwd: tests, timeout: 30000, env: { PATH: process.env.PATH, CI: "1", NODE_OPTIONS: "", NODE_PATH: "" } }).then(() => { throw new Error("Original should fail"); }, error => { expect(error.code).toBe(1); });
  await rm(path.join(f.cell, "playwright-output"), { recursive: true });
  for (const folder of ["playwright-output", "html-report", "blob-report"]) await cp(path.join(f.source, folder), path.join(f.cell, folder), { recursive: true });
  const owner = await privateCellEvidenceOwner(context, id), prefix = `gha-123-1-${id}/chat-features/runner-opencode/local/activity.agent-feedback/attempt-1`;
  const upload = path.join(context.root, "results", prefix);
  const input = { privateDir: f.cell, uploadDir: upload, secrets: [], expectPassScreenshot: false, privateCell: { owner, layout: "original" as const } };
  await expect(packageEvidence(input)).rejects.toThrow("Private cell evidence exceeds byte allowance");
  for (const folder of ["html-report", "blob-report"]) await rm(path.join(f.cell, folder), { recursive: true });
  await copyPrivateFrameworkReport(f.source, f.cell, []);
  await writeFile(path.join(f.cell, "result.json"), '{"status":"failed","error":"original failed assertion"}');
  const evidence = await packageEvidence(input); expect(evidence.leaks).toEqual([]); expect(evidence.budget?.bytesExamined).toBeLessThan(256 * 1024 * 1024);
  await sealStandardOriginalEvidence({ context, executionId: id, source: f.cell, evidence, secrets: [], expectPassScreenshot: false });
  const original = path.join(context.root, "originals", manualCellKind(id));
  await referenceSealedFrameworkAttachments(upload, original, id);
  await sealManualResultEvidence(context, []);
  expect((await validateSealedOriginals(context.root, id, context)).complete).toBe(true);
  expect((await validateSealedInventory(path.join(context.root, "sealed-results/html-report"), "../result-evidence-inventory.json", undefined, "standard", context)).complete).toBe(true);
  const bundle = path.join(context.root, "bundle"); await mkdir(bundle);
  await cp(path.join(context.root, "originals"), path.join(bundle, "originals"), { recursive: true });
  await cp(path.join(context.root, "sealed-results"), path.join(bundle, "sealed-results"), { recursive: true });
  const archive = path.join(context.root, "retained.zip"), restored = path.join(context.root, "restored");
  await archivePrivateEvidence("pack", bundle, archive); await archivePrivateEvidence("unpack", archive, restored);
  const downloaded = { ...context, root: restored };
  await expect(validateSealedOriginals(restored, id, downloaded)).resolves.toMatchObject({ complete: true });
  await expect(validateSealedInventory(path.join(restored, "sealed-results/html-report"), "../result-evidence-inventory.json", undefined, "standard", downloaded)).resolves.toMatchObject({ complete: true });
  expect(JSON.parse(await readFile(path.join(restored, "originals", manualCellKind(id), "result.json"), "utf8")).status).toBe("failed");
}, 30000);

it.each(["literal", "escaped", "base64-body", "escaped-json-body"])("deep-scans registered immutable raw JSON text: %s", async kind => {
  const f = await fixture(), canary = "synthetic-private-credential";
  const attachment = f.report.suites[0]!.specs[0]!.tests[0]!.results[0]!.attachments[0]! as any;
  if (kind === "literal" || kind === "escaped") f.report.errors = [{ message: canary }] as any;
  else {
    attachment.contentType = kind === "base64-body" ? "text/plain" : "application/json";
    attachment.body = Buffer.from(kind === "base64-body" ? canary : JSON.stringify({ value: canary }).replace("s", "\\u0073")).toString("base64");
  }
  let raw = JSON.stringify(f.report);
  if (kind === "escaped") raw = raw.replace(canary, "\\u0073" + canary.slice(1));
  expect(() => inspectPrivateFrameworkMetadata(PRIVATE_FRAMEWORK_ORIGINAL_REPORT, raw, [canary])).toThrow();
});
it("retains and checks a clean official inline text attachment without losing its body", async () => {
  const f = await fixture(); const attachment = f.report.suites[0]!.specs[0]!.tests[0]!.results[0]!.attachments[0]! as any;
  attachment.contentType = "text/plain"; attachment.body = Buffer.from("safe diagnostic").toString("base64");
  await writeFile(path.join(f.source, "framework-report.json"), JSON.stringify(f.report));
  await copyPrivateFrameworkReport(f.source, f.cell, []);
  const retained = await validatePrivateFrameworkReport(f.cell);
  expect((retained.report.suites as any)[0].specs[0].tests[0].results[0].attachments[0].body).toBe(attachment.body);
});

it("rejects a symbolic attachment and changed final framework outcome", async () => {
  const f = await fixture(), file = path.join(f.cell, "playwright-output/owned/trace.zip");
  await rm(file); await symlink(path.join(f.source, "playwright-output/owned/trace.zip"), file);
  await expect(copyPrivateFrameworkReport(f.source, f.cell, [])).rejects.toThrow();
  await rm(file); await cp(path.join(f.source, "playwright-output/owned/trace.zip"), file);
  await copyPrivateFrameworkReport(f.source, f.cell, []);
  const original = path.join(f.root, "original"); await cp(f.cell, original, { recursive: true });
  await referenceSealedFrameworkAttachments(f.cell, original, "owned");
  const sidecar = JSON.parse(await readFile(path.join(f.cell, PRIVATE_FRAMEWORK_REPORT), "utf8"));
  sidecar.report.suites[0].specs[0].tests[0].results[0].status = "passed";
  await writeFile(path.join(f.cell, PRIVATE_FRAMEWORK_REPORT), JSON.stringify(sidecar));
  await expect(validatePrivateFrameworkReport(f.cell, original, "owned")).rejects.toThrow();
});
