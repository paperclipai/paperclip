import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { copySharedEvidence } from "./shared-evidence.js";
import { packageEvidence } from "./evidence.js";
import { sealManualResultEvidence, sealStandardOriginalEvidence, type ManualPrivateHandoff } from "./manual-private-handoff.js";
import { inspectCellReportProducer, privateCellEvidenceOwner, type CellReportProducerIdentity } from "./manual-private-report-assets.js";
import { stageSealedPrivateCell, validateSealedInventory, validateSealedOriginals } from "./manual-private-transfer.js";
import { MANUAL_PRIVATE_EXECUTIONS, MANUAL_PRIVATE_PROTOCOL, manualCellKind } from "./manual-private-retention.js";
import { archivePrivateEvidence } from "./private-history.js";
import { dropDuplicatePlaywrightOutput, PRIVATE_REPORT_COPIES_RECEIPT } from "./private-report-copies.js";

const sha1 = (value: Buffer) => createHash("sha1").update(value).digest("hex");
const roots: string[] = [];
const temporaryRoot = await realpath(os.tmpdir());
let reporter: string, producerRoot: string, producer: CellReportProducerIdentity;

async function files(root: string, relative = ""): Promise<string[]> {
  const found: string[] = [];
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) found.push(...await files(root, name)); else found.push(name);
  }
  return found.sort();
}
async function bytesOf(root: string) {
  let total = 0;
  for (const name of await files(root)) total += (await lstat(path.join(root, name))).size;
  return total;
}

beforeAll(async () => {
  producerRoot = await mkdtemp(path.join(temporaryRoot, "synthetic-report-copies-"));
  reporter = path.join(producerRoot, "reporter"); const tests = path.join(producerRoot, "node-tests");
  await Promise.all([mkdir(reporter), mkdir(tests)]);
  const require = createRequire(import.meta.url), pkg = require.resolve("@playwright/test/package.json"), entry = require.resolve("@playwright/test");
  await writeFile(path.join(tests, "failure.spec.cjs"), `const {test,expect}=require(${JSON.stringify(entry)});test('synthetic retained failure',async({},info)=>{await info.attach('synthetic-video',{body:Buffer.from('synthetic video bytes'),contentType:'video/webm'});expect('actual wrong outcome').toBe('expected outcome');});`);
  const config = path.join(tests, "isolated.config.cjs");
  // The same reporter set as the private chat lane: HTML, JUnit and blob.
  await writeFile(config, `module.exports=${JSON.stringify({ testDir: tests, testMatch: "failure.spec.cjs", workers: 1, outputDir: path.join(reporter, "playwright-output"), use: { trace: "retain-on-failure" }, reporter: [["html", { outputFolder: path.join(reporter, "html-report"), open: "never" }], ["junit", { outputFile: path.join(reporter, "junit.xml") }], ["blob", { outputDir: path.join(reporter, "blob-report") }]] })};`);
  const failed = await promisify(execFile)(process.execPath, [path.join(path.dirname(pkg), "cli.js"), "test", "--config", config], { cwd: tests, timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, CI: "1", NODE_OPTIONS: "", NODE_PATH: "", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } }).then(() => false, error => { expect(error.code).toBe(1); return true; });
  expect(failed).toBe(true);
  producer = await inspectCellReportProducer();
}, 30_000);
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
afterAll(async () => { await rm(producerRoot, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(temporaryRoot, "synthetic-private-copies-")); roots.push(root);
  const id = MANUAL_PRIVATE_EXECUTIONS[0]!, cell = path.join(root, "capture/cases/activity.agent-feedback"); await mkdir(cell, { recursive: true });
  await copySharedEvidence(reporter, cell, path.join(root, "controller"), []);
  await writeFile(path.join(cell, "result.json"), '{"status":"failed","failureClass":"assertion"}');
  const context = { root, private: true, protocol: MANUAL_PRIVATE_PROTOCOL, workflowSha: "a".repeat(40), targetSha: "b".repeat(40), runId: "123", attempt: "1", executionIds: [id], cellReportProducer: producer } as ManualPrivateHandoff;
  const prefix = `gha-123-1-${id}/chat-features/runner-opencode/local/activity.agent-feedback/attempt-1`;
  return { root, id, cell, context, prefix, upload: path.join(root, "results", prefix) };
}
async function traceOf(cell: string) {
  const outputs = (await files(cell)).filter(name => /^playwright-output\/[^/]+\/trace\.zip$/.test(name));
  expect(outputs).toHaveLength(1);
  return { relative: outputs[0]!, bytes: await readFile(path.join(cell, outputs[0]!)) };
}

it("drops only playwright-output copies the HTML report already holds, leaving the HTML report and blob report unchanged", async () => {
  const f = await fixture(), trace = await traceOf(f.cell);
  const keptAt = `html-report/data/${sha1(trace.bytes)}.zip`;
  expect(await readFile(path.join(f.cell, keptAt))).toEqual(trace.bytes);
  const before = await files(f.cell), reports = before.filter(name => /^(?:html-report|blob-report)\//.test(name));
  const reportBytes = await Promise.all(reports.map(name => readFile(path.join(f.cell, name))));
  const dropped = await dropDuplicatePlaywrightOutput(f.cell);
  expect(dropped.map(row => row.path)).toContain(trace.relative);
  expect(dropped.find(row => row.path === trace.relative)).toMatchObject({ keptAt, bytes: trace.bytes.length });
  // Every dropped file has its exact bytes at the recorded HTML report path.
  for (const row of dropped) expect(sha1(await readFile(path.join(f.cell, row.keptAt)))).toBe(path.basename(row.keptAt, path.extname(row.keptAt)));
  const after = await files(f.cell);
  expect(after.filter(name => name.endsWith("trace.zip"))).toEqual([]);
  expect(after).toContain(keptAt);
  expect(await Promise.all(reports.map(name => readFile(path.join(f.cell, name))))).toEqual(reportBytes);
  // Files the HTML report does not copy, such as the run bookkeeping, stay.
  expect(after).toContain("playwright-output/.last-run.json");
  expect(JSON.parse(await readFile(path.join(f.cell, PRIVATE_REPORT_COPIES_RECEIPT), "utf8")).dropped).toEqual(dropped);
});

it("keeps every validator accepting the deduplicated cell through package, both seals, trusted transfer, archive and report staging", async () => {
  const f = await fixture(), trace = await traceOf(f.cell);
  const keptAt = `html-report/data/${sha1(trace.bytes)}.zip`;
  const originalBytes = await bytesOf(f.cell);
  const dropped = await dropDuplicatePlaywrightOutput(f.cell);
  const receiptBytes = (await lstat(path.join(f.cell, PRIVATE_REPORT_COPIES_RECEIPT))).size;
  expect(originalBytes - await bytesOf(f.cell) + receiptBytes).toBe(dropped.reduce((sum, row) => sum + row.bytes, 0));
  const owner = await privateCellEvidenceOwner(f.context, f.id);
  const evidence = await packageEvidence({ privateDir: f.cell, uploadDir: f.upload, secrets: [], expectPassScreenshot: false, privateCell: { owner, layout: "original" } });
  expect(evidence.leaks).toEqual([]);
  const original = await sealStandardOriginalEvidence({ context: f.context, executionId: f.id, source: f.cell, evidence, secrets: [], expectPassScreenshot: false });
  await sealManualResultEvidence(f.context, []);
  const originalDir = path.join(f.root, "originals", manualCellKind(f.id)), finalDir = path.join(f.root, "sealed-results/html-report");
  expect((await validateSealedOriginals(f.root, f.id, f.context)).inventorySha256).toBe(original.inventorySha256);
  const final = await validateSealedInventory(finalDir, "../result-evidence-inventory.json", undefined, "standard", f.context);
  for (const tree of [original.files.map((row: { path: string }) => row.path), final.files.map((row: { path: string }) => row.path.slice(f.prefix.length + 1))]) {
    expect(tree).toContain(keptAt);
    expect(tree).toContain(PRIVATE_REPORT_COPIES_RECEIPT);
    expect(tree.filter((name: string) => name.endsWith("trace.zip"))).toEqual([]);
    expect(tree.some((name: string) => /^blob-report\/.+\.zip$/.test(name))).toBe(true);
  }
  expect(await readFile(path.join(originalDir, keptAt))).toEqual(trace.bytes);
  const bundle = path.join(f.root, "bundle"); await mkdir(bundle);
  await cp(path.join(f.root, "originals"), path.join(bundle, "originals"), { recursive: true });
  await cp(path.join(f.root, "sealed-results"), path.join(bundle, "sealed-results"), { recursive: true });
  await writeFile(path.join(bundle, "identity.json"), JSON.stringify(f.context));
  const zip = path.join(f.root, "retained.zip"), restored = path.join(f.root, "restored");
  await archivePrivateEvidence("pack", bundle, zip); await archivePrivateEvidence("unpack", zip, restored);
  const downloaded = { ...f.context, root: restored };
  expect((await validateSealedOriginals(restored, f.id, downloaded)).complete).toBe(true);
  const selected = path.join(f.root, "selected"); await mkdir(selected);
  await stageSealedPrivateCell(restored, selected, f.id, downloaded);
  const staged = path.join(selected, manualCellKind(f.id), f.prefix);
  expect(await readFile(path.join(staged, keptAt))).toEqual(trace.bytes);
});

it("keeps the playwright-output file when the HTML report copy is missing, differs, or is not a regular file", async () => {
  const f = await fixture(), trace = await traceOf(f.cell), keptAt = path.join(f.cell, `html-report/data/${sha1(trace.bytes)}.zip`);
  const tampered = Buffer.from(trace.bytes); tampered[tampered.length - 1] ^= 1;
  await writeFile(keptAt, tampered);
  expect((await dropDuplicatePlaywrightOutput(f.cell)).map(row => row.path)).not.toContain(trace.relative);
  expect(await readFile(path.join(f.cell, trace.relative))).toEqual(trace.bytes);
  await rm(path.join(f.cell, PRIVATE_REPORT_COPIES_RECEIPT), { force: true });
  await rm(keptAt); await symlink(path.join(f.cell, trace.relative), keptAt);
  expect((await dropDuplicatePlaywrightOutput(f.cell)).map(row => row.path)).not.toContain(trace.relative);
  expect(await readFile(path.join(f.cell, trace.relative))).toEqual(trace.bytes);
});

it("leaves trees alone when the HTML data directory is a symlink or the framework JSON reporter owns playwright-output", async () => {
  const linked = await fixture(), data = path.join(linked.cell, "html-report/data"), moved = path.join(linked.root, "moved-data");
  await cp(data, moved, { recursive: true }); await rm(data, { recursive: true }); await symlink(moved, data);
  const linkedBefore = await files(linked.cell);
  expect(await dropDuplicatePlaywrightOutput(linked.cell)).toEqual([]);
  expect(await files(linked.cell)).toEqual(linkedBefore);
  const framework = await fixture();
  await writeFile(path.join(framework.cell, "framework-report.json"), "{}");
  const frameworkBefore = await files(framework.cell);
  expect(await dropDuplicatePlaywrightOutput(framework.cell)).toEqual([]);
  expect(await files(framework.cell)).toEqual(frameworkBefore);
});
