import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
const reads = vi.hoisted(() => ({ files: [] as string[], directories: [] as string[], oversized: "" }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    readFile: ((...args: Parameters<typeof actual.readFile>) => { reads.files.push(String(args[0])); return actual.readFile(...args); }) as typeof actual.readFile,
    readdir: ((...args: Parameters<typeof actual.readdir>) => { reads.directories.push(String(args[0])); return actual.readdir(...args); }) as typeof actual.readdir,
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      const metadata = await actual.lstat(...args);
      return String(args[0]) === reads.oversized ? Object.assign(metadata, { size: 256 * 1024 * 1024 + 1 }) : metadata;
    }) as typeof actual.lstat,
  };
});
import { copySharedEvidence } from "./shared-evidence.js";
import { packageEvidence, publishRunnerE2EAttemptEvidence, isStandardEvidencePath } from "./evidence.js";
import { readManualPrivateHandoff, sealStandardOriginalEvidence, sealManualResultEvidence, preserveOriginalFrameworkResult, type ManualPrivateHandoff } from "./manual-private-handoff.js";
import { canonicalGeneratedReportAsset, cellTraceAsset, inspectCellReportProducer, privateCellEvidenceOwner, readPrivateCellTraceAsset, type CellReportProducerIdentity } from "./manual-private-report-assets.js";
import { validateSealedInventory, validateSealedOriginals } from "./manual-private-transfer.js";
import { MANUAL_PRIVATE_EXECUTIONS, MANUAL_PRIVATE_PROTOCOL, manualCellKind } from "./manual-private-retention.js";
import { archivePrivateEvidence, retainPrivateTransfer } from "./private-history.js";
import { BoundedHistoryPublisher } from "./history-budget.js";
import { sanitizeJson } from "./redaction.js";
import type { RunnerE2EResult } from "./types.js";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
const temporaryRoot = await realpath(os.tmpdir());
let reporter: string, producerRoot: string, producer: CellReportProducerIdentity;
beforeAll(async () => {
  producerRoot = await mkdtemp(path.join(temporaryRoot, "synthetic-cell-producer-"));
  reporter = path.join(producerRoot, "reporter"); const tests = path.join(producerRoot, "node-tests");
  await Promise.all([mkdir(reporter), mkdir(tests)]);
  const require = createRequire(import.meta.url), pkg = require.resolve("@playwright/test/package.json"), entry = require.resolve("@playwright/test");
  await writeFile(path.join(tests, "failure.spec.cjs"), `const {test,expect}=require(${JSON.stringify(entry)});test('synthetic Node-only retained failure',async()=>{expect('actual wrong outcome').toBe('expected outcome');});`);
  const config = path.join(tests, "isolated.config.cjs");
  await writeFile(config, `module.exports=${JSON.stringify({ testDir: tests, testMatch: "failure.spec.cjs", workers: 1, outputDir: path.join(reporter, "playwright-output"), use: { trace: "retain-on-failure" }, reporter: [["html", { outputFolder: path.join(reporter, "html-report"), open: "never" }], ["junit", { outputFile: path.join(reporter, "junit.xml") }], ["blob", { outputDir: path.join(reporter, "blob-report") }]] })};`);
  const failed = await promisify(execFile)(process.execPath, [path.join(path.dirname(pkg), "cli.js"), "test", "--config", config], { cwd: tests, timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, CI: "1", NODE_OPTIONS: "", NODE_PATH: "", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } }).then(() => false, error => { expect(error.code).toBe(1); return true; });
  expect(failed).toBe(true);
  // A real automatic TestTracing attachment, not a manually attached fake trace.
  const outputs = await readdir(path.join(reporter, "playwright-output"));
  expect(await Promise.all(outputs.filter(name => !name.startsWith(".")).map(name => readdir(path.join(reporter, "playwright-output", name))))).toContainEqual(expect.arrayContaining(["trace.zip"]));
  producer = await inspectCellReportProducer();
}, 30_000);
afterEach(async () => { reads.oversized = ""; reads.files.length = 0; reads.directories.length = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
afterAll(async () => { await rm(producerRoot, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(temporaryRoot, "synthetic-private-cell-")); roots.push(root);
  const id = MANUAL_PRIVATE_EXECUTIONS[0]!, cell = path.join(root, "capture/cases/activity.agent-feedback"); await mkdir(cell, { recursive: true });
  await copySharedEvidence(reporter, cell, path.join(root, "controller"), []);
  await writeFile(path.join(cell, "result.json"), '{"status":"failed","failureClass":"assertion"}');
  const context = { root, private: true, protocol: MANUAL_PRIVATE_PROTOCOL, workflowSha: "a".repeat(40), targetSha: "b".repeat(40), runId: "123", attempt: "1", executionIds: [id], cellReportProducer: producer } as ManualPrivateHandoff;
  const owner = await privateCellEvidenceOwner(context, id), prefix = `gha-123-1-${id}/chat-features/runner-opencode/local/activity.agent-feedback/attempt-1`;
  return { root, id, cell, context, owner, prefix, upload: path.join(root, "results", prefix) };
}
function syntheticTransport(objects: Map<string, Buffer>) {
  return async (args: string[]) => {
    const operation = args[1]!;
    if (operation === "put-object") {
      expect(args.slice(args.indexOf("--if-none-match"), args.indexOf("--if-none-match") + 2)).toEqual(["--if-none-match", "*"]);
      const key = args[args.indexOf("--key") + 1]!; expect(objects.has(key)).toBe(false);
      objects.set(key, await readFile(args[args.indexOf("--body") + 1]!));
      return { stdout: JSON.stringify({ VersionId: `synthetic-version-${objects.size}` }) };
    }
    if (operation === "get-object-lock-configuration" || operation === "get-bucket-replication") throw new Error(operation === "get-object-lock-configuration" ? "(ObjectLockConfigurationNotFoundError)" : "(ReplicationConfigurationNotFoundError)");
    const replies: Record<string, unknown> = {
      "get-bucket-versioning": { Status: "Enabled" },
      "get-bucket-lifecycle-configuration": { Rules: [
        { Status: "Enabled", Filter: { Prefix: "runner-e2e-private/bounded-v1/" }, Expiration: { Days: 30 }, NoncurrentVersionExpiration: { NoncurrentDays: 1 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
        { Status: "Enabled", Filter: { Prefix: "runner-e2e-private/bounded-v1/" }, Expiration: { ExpiredObjectDeleteMarker: true } },
      ] },
      "get-public-access-block": { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } },
      "get-bucket-ownership-controls": { OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] } },
      "get-bucket-policy": { Policy: JSON.stringify({ Statement: [{ Effect: "Deny" }] }) },
    };
    if (!(operation in replies)) throw new Error("Unexpected synthetic transport operation");
    return { stdout: JSON.stringify(replies[operation]) };
  };
}
it("retains the real failed trace/report through actual copy, private package, both seals, trusted validator, strict archive and immutable receipt", async () => {
  const f = await fixture();
  const evidence = await packageEvidence({ privateDir: f.cell, uploadDir: f.upload, secrets: [], expectPassScreenshot: false, privateCell: { owner: f.owner, layout: "original" } });
  expect(evidence.leaks).toEqual([]);
  for (const name of ["playwright-logo.svg", "manifest.webmanifest", "index.html"]) expect(evidence.files).toContain(`html-report/trace/${name}`);
  expect(evidence.files.some(name => name.endsWith(".ttf"))).toBe(true);
  const original = await sealStandardOriginalEvidence({ context: f.context, executionId: f.id, source: f.cell, evidence, secrets: [], expectPassScreenshot: false });
  await sealManualResultEvidence(f.context, []);
  const originalDir = path.join(f.root, "originals", manualCellKind(f.id)), finalDir = path.join(f.root, "sealed-results/html-report");
  expect((await validateSealedOriginals(f.root, f.id, f.context)).inventorySha256).toBe(original.inventorySha256);
  const final = await validateSealedInventory(finalDir, "../result-evidence-inventory.json", undefined, "standard", f.context);
  for (const name of ["playwright-logo.svg", "manifest.webmanifest", "index.html"]) {
    const bytes = await readFile(canonicalGeneratedReportAsset(`html/trace/${name}`)!);
    expect(await readFile(path.join(originalDir, "html-report/trace", name))).toEqual(bytes);
    expect(await readFile(path.join(finalDir, f.prefix, "html-report/trace", name))).toEqual(bytes);
    expect(final.files).toContainEqual({ path: `${f.prefix}/html-report/trace/${name}`, bytes: bytes.length, sha256: hash(bytes) });
  }
  const bundle = path.join(f.root, "bundle"); await mkdir(bundle);
  await cp(path.join(f.root, "originals"), path.join(bundle, "originals"), { recursive: true });
  await cp(path.join(f.root, "sealed-results"), path.join(bundle, "sealed-results"), { recursive: true });
  const objects = new Map<string, Buffer>(), receipt = path.join(f.root, "transport.json"), runner = syntheticTransport(objects);
  const transferred = await retainPrivateTransfer({ operation: "upload", kind: manualCellKind(f.id), runId: "123", directory: bundle, bucket: "synthetic-private-bucket", publisher: new BoundedHistoryPublisher(receipt, runner), evidenceCompleteness: { meaning: "available-files-and-transfer-only", doesNotAttestFeatureOutcome: true, cells: [{ executionId: f.id, availableFileInventoryComplete: true, requiredPassEvidenceComplete: null, missingRequiredEvidence: [] }] } }, receipt, () => new BoundedHistoryPublisher(`${receipt}.retention`, runner));
  expect(objects.size).toBe(2); expect(transferred).toHaveProperty("versionId", "synthetic-version-1");
  const retainedReceipt = JSON.parse([...objects.values()][1]!.toString()); expect(retainedReceipt.transfer.sha256).toBe(hash([...objects.values()][0]!));
  expect(retainedReceipt.evidenceCompleteness.doesNotAttestFeatureOutcome).toBe(true);
  const zip = path.join(f.root, "retained.zip"), restored = path.join(f.root, "restored"); await writeFile(zip, [...objects.values()][0]!); await archivePrivateEvidence("unpack", zip, restored);
  expect(JSON.parse(await readFile(path.join(restored, "originals", manualCellKind(f.id), "result.json"), "utf8")).status).toBe("failed");
  const downloaded = { ...f.context, root: restored };
  expect((await validateSealedOriginals(restored, f.id, downloaded)).complete).toBe(true);
  expect((await validateSealedInventory(path.join(restored, "sealed-results/html-report"), "../result-evidence-inventory.json", undefined, "standard", downloaded)).complete).toBe(true);
  expect(await readFile(path.join(restored, "sealed-results/html-report", f.prefix, "html-report/trace/playwright-logo.svg"))).toEqual(await readFile(canonicalGeneratedReportAsset("html/trace/playwright-logo.svg")!));
}, 60_000);
it.each(["wrong-case", "wrong-run", "wrong-attempt", "double-wrapper", "extra-nesting", "watch", "xterm", "tampered-html", "tampered-svg", "shape"])("actual package rejects %s in the reserved cell namespace", async kind => {
  const f = await fixture(); let relative = "html-report/trace/index.html";
  if (kind === "watch") relative = "html-report/trace/watch.js";
  else if (kind === "xterm") relative = "html-report/trace/assets/xtermModule.synthetic.js";
  else if (kind === "tampered-svg") relative = "html-report/trace/playwright-logo.svg";
  else if (["wrong-case", "wrong-run", "wrong-attempt", "double-wrapper", "extra-nesting"].includes(kind)) {
    relative = `${f.prefix}/html-report/trace/index.html`;
    if (kind === "wrong-case") relative = relative.replace("/activity.agent-feedback/", "/activity.work-timeline/");
    if (kind === "wrong-run") relative = relative.replace("gha-123-", "gha-124-");
    if (kind === "wrong-attempt") relative = relative.replace("attempt-1/", "attempt-2/");
    if (kind === "double-wrapper") relative = `html-report/html-report/${relative}`;
    else relative = `html-report/${kind === "extra-nesting" ? "extra/" : ""}${relative}`;
  }
  await mkdir(path.dirname(path.join(f.cell, relative)), { recursive: true });
  await writeFile(path.join(f.cell, relative), kind === "shape" ? "sk-proj-synthetic123456789012345" : "changed or foreign canonical script");
  await expect(packageEvidence({ privateDir: f.cell, uploadDir: f.upload, secrets: [], expectPassScreenshot: false, privateCell: { owner: f.owner, layout: "original" } })).rejects.toThrow(/private cell trace|canonical/);
});
it.each(["final", "final-wrapper"] as const)("binds exactly the %s layout without prefix stripping", async layout => {
  const f = await fixture(), suffix = "html-report/trace/index.html", proper = `${layout === "final-wrapper" ? "html-report/" : ""}${f.prefix}/${suffix}`;
  expect(cellTraceAsset(proper, f.owner, layout).canonical).toBe(canonicalGeneratedReportAsset("html/trace/index.html"));
  expect(cellTraceAsset(`html-report/${proper}`, f.owner, layout)).toEqual({ reserved: true, canonical: undefined });
  expect(cellTraceAsset(proper.replace("/activity.agent-feedback/", "/activity.work-timeline/"), f.owner, layout).canonical).toBeUndefined();
});
it("registered roots remain protected even when equal to genuine public static bytes", async () => {
  const f = await fixture(), bytes = await readFile(canonicalGeneratedReportAsset("html/trace/index.html")!);
  expect(bytes.toString()).toContain("Playwright");
  await expect(packageEvidence({ privateDir: f.cell, uploadDir: f.upload, secrets: ["Playwright"], expectPassScreenshot: false, privateCell: { owner: f.owner, layout: "original" } })).rejects.toThrow(/Secret leak/);
});
it.each(["encoded", "unknown-shape"])("private cell original scan still rejects %s contamination in standard evidence", async kind => {
  const f = await fixture(), secret = "synthetic-credential-1234567890";
  await mkdir(path.join(f.cell, "snapshots"));
  await writeFile(path.join(f.cell, "snapshots/unsafe.txt"), kind === "encoded" ? Buffer.from(secret).toString("base64") : "sk-proj-synthetic123456789012345");
  await expect(sealStandardOriginalEvidence({ context: f.context, executionId: f.id, source: f.cell, evidence: { files: [], leaks: [], missing: [] }, secrets: [secret], expectPassScreenshot: false })).rejects.toThrow(/privacy/);
});
it.each(["unknown", "oversize", "symlink"])("rejects %s before reading a cell static body", async kind => {
  const f = await fixture(), file = path.join(f.cell, "html-report/trace", kind === "unknown" ? "unknown.bin" : "index.html");
  if (kind === "unknown") await writeFile(file, "synthetic");
  if (kind === "oversize") reads.oversized = file;
  if (kind === "symlink") { await rm(file); await symlink(canonicalGeneratedReportAsset("html/trace/index.html")!, file); }
  reads.files.length = 0;
  await expect(readPrivateCellTraceAsset({ owner: f.owner, layout: "original", relative: path.relative(f.cell, file), file, remaining: 256 * 1024 * 1024, secrets: [] })).rejects.toThrow();
  expect(reads.files).not.toContain(file);
});
it("rejects public or overlapping output roots and unverified private flags before deleting output", async () => {
  const f = await fixture(), outside = await mkdtemp(path.join(temporaryRoot, "synthetic-public-destination-")); roots.push(outside); await writeFile(path.join(outside, "keep.txt"), "keep");
  for (const [uploadDir, owner] of [[outside, f.owner], [f.cell, f.owner], [f.upload, { ...f.owner }]] as const)
    await expect(packageEvidence({ privateDir: f.cell, uploadDir, secrets: [], expectPassScreenshot: false, privateCell: { owner, layout: "original" } })).rejects.toThrow();
  expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
});
it.each(["missing", "same-version-tamper"])("actual preflight rejects %s producer before a fixture callback", async kind => {
  const f = await fixture(), file = path.join(f.root, "preflight.json");
  const wrong = structuredClone(producer); wrong.producers[0]!.sha256 = "0".repeat(64);
  await writeFile(file, JSON.stringify({ ...f.context, status: "verified", cellReportProducer: kind === "missing" ? undefined : wrong }), { mode: 0o600 });
  const env = { PAPERCLIP_RUNNER_E2E_PRIVATE_PREFLIGHT: file, RUNNER_TEMP: temporaryRoot, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: f.context.workflowSha, PAPERCLIP_RUNNER_E2E_SOURCE_SHA: f.context.targetSha };
  let callbacks = 0;
  await expect(readManualPrivateHandoff(env, [f.id]).then(() => { callbacks++; })).rejects.toThrow(/producer/);
  expect(callbacks).toBe(0);
});
it("does not enable static SVG or unknown carriers in the default public package or default cell seal", async () => {
  const f = await fixture(); const publicPackage = await packageEvidence({ privateDir: f.cell, uploadDir: f.upload, secrets: [], expectPassScreenshot: false });
  expect(publicPackage.files).not.toContain("html-report/trace/playwright-logo.svg");
  const noProducer = { ...f.context, cellReportProducer: undefined };
  await expect(sealStandardOriginalEvidence({ context: noProducer, executionId: f.id, source: f.cell, evidence: publicPackage, secrets: [], expectPassScreenshot: false })).rejects.toThrow(/Unsupported/);
});
it.each(["tampered-html", "foreign-case", "foreign-run", "double-wrapper", "watch"])("trusted validator rejects rehashed %s cell inventory", async kind => {
  const f = await fixture(); let relative = `${f.prefix}/html-report/trace/index.html`;
  if (kind === "foreign-case") relative = relative.replace("/activity.agent-feedback/", "/activity.work-timeline/");
  if (kind === "foreign-run") relative = relative.replace("gha-123-", "gha-124-");
  if (kind === "double-wrapper") relative = `html-report/html-report/${relative}`;
  if (kind === "watch") relative = `${f.prefix}/html-report/trace/watch.js`;
  const directory = path.join(f.root, "forged-final"), data = Buffer.from("same standard-extension script with forged inventory");
  await mkdir(path.dirname(path.join(directory, relative)), { recursive: true }); await writeFile(path.join(directory, relative), data);
  const files = [{ path: relative, bytes: data.length, sha256: hash(data) }];
  await writeFile(path.join(directory, "inventory.json"), JSON.stringify({ protocol: MANUAL_PRIVATE_PROTOCOL, treeKind: "standard", complete: true, files, sourceBytes: data.length, inventorySha256: hash(JSON.stringify(files)) }));
  reads.files.length = 0;
  await expect(validateSealedInventory(directory, "inventory.json", undefined, "standard", f.context)).rejects.toThrow(/private cell trace|canonical/);
  if (kind !== "tampered-html") expect(reads.files).not.toContain(path.join(directory, relative));
});
it.each(["snapshots/unknown.svg", "snapshots/unknown.bin"])("verified private packaging still rejects unowned %s", async relative => {
  const f = await fixture(); await mkdir(path.dirname(path.join(f.cell, relative)), { recursive: true }); await writeFile(path.join(f.cell, relative), "synthetic unsupported");
  await expect(packageEvidence({ privateDir: f.cell, uploadDir: f.upload, secrets: [], expectPassScreenshot: false, privateCell: { owner: f.owner, layout: "original" } })).rejects.toThrow(/Unsupported/);
});

it("accepts the actual compact portable producer identity before callbacks", async () => {
  const f = await fixture(), file = path.join(f.root, "preflight.json");
  const serialized = JSON.stringify({ ...f.context, status: "verified" });
  expect(Buffer.byteLength(serialized)).toBeLessThan(65536);
  expect(JSON.stringify(producer)).not.toContain(temporaryRoot);
  await writeFile(file, serialized, { mode: 0o600 });
  const env = { PAPERCLIP_RUNNER_E2E_PRIVATE_PREFLIGHT: file, RUNNER_TEMP: temporaryRoot, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: f.context.workflowSha, PAPERCLIP_RUNNER_E2E_SOURCE_SHA: f.context.targetSha };
  expect((await readManualPrivateHandoff(env, [f.id]))?.cellReportProducer).toEqual(producer);
});

it("does not silently package final rows using an unsupported unwrapped layout", async () => {
  const f = await fixture(); await mkdir(f.upload, { recursive: true }); await writeFile(path.join(f.upload, "keep.txt"), "keep");
  await expect(packageEvidence({ privateDir: path.join(f.root, "results"), uploadDir: path.join(f.root, "bad-layout"), secrets: [], expectPassScreenshot: false,
    privateCell: { owner: f.owner, layout: "final" as "original" } })).rejects.toThrow(/layout/);
  expect(await readFile(path.join(f.upload, "keep.txt"), "utf8")).toBe("keep");
});

it("rejects a registered public-path match before reading its genuine static body", async () => {
  const f = await fixture(), file = path.join(f.cell, "html-report/trace/index.html"); reads.files.length = 0;
  await expect(readPrivateCellTraceAsset({ owner: f.owner, layout: "original", relative: "html-report/trace/index.html", file, remaining: 256 * 1024 * 1024, secrets: ["index.html"] })).rejects.toThrow(/Secret leak/);
  expect(reads.files).not.toContain(file);
});

async function stagingFixture() {
  const root = await mkdtemp(path.join(temporaryRoot, "synthetic-excluded-cell-staging-")); roots.push(root);
  const id = "chat-features.runner-opencode.local.onboarding.new-instance", source = path.join(root, "capture/cases/onboarding.new-instance");
  await mkdir(source, { recursive: true });
  const owner = await privateCellEvidenceOwner({ private: true, root, runId: "123", attempt: "1", executionIds: [id], cellReportProducer: producer }, id);
  return { root, source, owner, uploadDir: path.join(root, "output") };
}
it("excluded installed staging neither consumes the standard allowance nor gets traversed", async () => {
  const f = await stagingFixture(), staging = path.join(f.source, "empty-installed-candidate-synthetic/installed/node_modules/synthetic-package");
  await mkdir(staging, { recursive: true });
  expect(isStandardEvidencePath("empty-installed-candidate-synthetic/installed/node_modules/synthetic-package/file-0.js")).toBe(false);
  for (let start = 0; start < 4096; start += 64) await Promise.all(Array.from({ length: 64 }, (_, offset) => writeFile(path.join(staging, `file-${start + offset}.js`), "")));
  await writeFile(path.join(f.source, "result.json"), '{"status":"failed","synthetic":true}');
  reads.directories.length = 0;
  const result = await packageEvidence({ privateDir: f.source, uploadDir: f.uploadDir, secrets: [], expectPassScreenshot: false, privateCell: { owner: f.owner, layout: "original" } });
  expect(result.files).toEqual(["result.json", "evidence-manifest.json"]); expect(result.leaks).toEqual([]);
  expect(reads.directories.some(directory => directory.includes("empty-installed-candidate-synthetic"))).toBe(false);
});
it("still rejects more than4096 genuine standard files, including node_modules within approved evidence", async () => {
  const f = await stagingFixture(), standard = path.join(f.source, "snapshots/node_modules/synthetic-package");
  await mkdir(standard, { recursive: true });
  for (let start = 0; start < 4097; start += 64) await Promise.all(Array.from({ length: Math.min(64, 4097 - start) }, (_, offset) => writeFile(path.join(standard, `file-${start + offset}.js`), "")));
  reads.files.length = 0;
  await expect(packageEvidence({ privateDir: f.source, uploadDir: f.uploadDir, secrets: [], expectPassScreenshot: false, privateCell: { owner: f.owner, layout: "original" } })).rejects.toThrow(/entry allowance/);
  expect(reads.files.some(file => file.startsWith(standard))).toBe(false);
});
it.each(["snapshots/node_modules/package/unknown.bin", "html-report/node_modules/package/unknown.svg"])("pruning staging does not ignore unapproved carrier %s within standard evidence", async relative => {
  const f = await stagingFixture(); await mkdir(path.dirname(path.join(f.source, relative)), { recursive: true }); await writeFile(path.join(f.source, relative), "synthetic unsupported");
  await expect(packageEvidence({ privateDir: f.source, uploadDir: f.uploadDir, secrets: [], expectPassScreenshot: false, privateCell: { owner: f.owner, layout: "original" } })).rejects.toThrow(/Unsupported/);
});

it.each([0, 1])("actual launcher packaging call %s retains the verified private producer tree", async index => {
 const source = await readFile(new URL("./launch.ts", import.meta.url), "utf8");
 const calls: string[] = [];
 for (const match of source.matchAll(/await packageEvidence\(/g)) {
  let depth = 1, quote = "", escaped = false, end = match.index! + match[0].length;
  for (; end < source.length && depth; end++) {
   const char = source[end]!;
   if (quote) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === quote) quote = ""; }
   else if (char === '"' || char === "'" || char === "`") quote = char;
   else if (char === "(") depth++;
   else if (char === ")") depth--;
  }
  calls.push(source.slice(match.index!, end));
 }
 expect(calls).toHaveLength(2);
 const code = stripTypeScriptTypes(`async function actualCall(manualPrivateHandoff, candidate, casePrivateDir, uploadDir, credentials, result) { return ${calls[index]}; }`, { mode: "strip" });
 const actualCall = Function("packageEvidence", "privateCellEvidenceOwner", `${code}; return actualCall;`)(packageEvidence, privateCellEvidenceOwner) as (context: ManualPrivateHandoff | undefined, candidate: { id: string }, source: string, target: string, secrets: string[], result: { status: string }) => ReturnType<typeof packageEvidence>;
 const f = await fixture();
 const packaged = await actualCall(f.context, { id: f.id }, f.cell, f.upload, [], { status: "failed" });
 for (const name of ["playwright-logo.svg", "manifest.webmanifest", "index.html"]) expect(packaged.files).toContain(`html-report/trace/${name}`);
});

async function actualLauncherEvidenceBranch(packageCall = packageEvidence) {
  const source = await readFile(new URL("./launch.ts", import.meta.url), "utf8");
  const start = source.indexOf("      if (manualPrivateHandoff) {\n        await preserveOriginalFrameworkResult(casePrivateDir);");
  const end = source.indexOf("      console.log(", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const code = stripTypeScriptTypes(`async function actualBranch(manualPrivateHandoff, candidate, casePrivateDir, resultsRoot, uploadDir, credentials, result, resultPath) { ${source.slice(start, end)} return result; }`, { mode: "strip" });
  const publisher = vi.fn(publishRunnerE2EAttemptEvidence);
  const branch = Function("preserveOriginalFrameworkResult", "writeFile", "sanitizeJson", "packageEvidence", "privateCellEvidenceOwner", "sealStandardOriginalEvidence", "publishRunnerE2EAttemptEvidence", `${code}; return actualBranch;`)(
    preserveOriginalFrameworkResult, writeFile, sanitizeJson, packageCall, privateCellEvidenceOwner, sealStandardOriginalEvidence, publisher,
  ) as (context: ManualPrivateHandoff | undefined, candidate: { id: string }, source: string, root: string, target: string, secrets: string[], result: RunnerE2EResult, resultPath: string) => Promise<RunnerE2EResult>;
  return { branch, publisher };
}
function failedLauncherResult(executionId: string): RunnerE2EResult {
  return { schema: "paperclip.runner-e2e.result/v2", executionId, suiteId: "chat-features", profileId: "runner-opencode", environmentId: "local", caseId: "activity.agent-feedback",
    attempt: 1, provider: "fixture", model: "fixture", runtimeMode: "native", status: "failed", cleanup: "not_started", failureClass: "candidate_failure",
    startedAt: "2026-10-29T00:00:00Z", finishedAt: "2026-10-29T00:00:01Z", durationMs: 1000 };
}
it("actual launcher public branch uses its normal publisher without retaining private-only trace assets", async () => {
  const f = await fixture(), resultsRoot = path.join(f.root, "ordinary-results"), uploadDir = path.join(resultsRoot, "campaign/attempt-1");
  const privatePackage = vi.fn(packageEvidence), { branch, publisher } = await actualLauncherEvidenceBranch(privatePackage);
  const result = await branch(undefined, { id: f.id }, f.cell, resultsRoot, uploadDir, [], failedLauncherResult(f.id), path.join(f.cell, "result.json"));
  expect(result.status).toBe("failed"); expect(publisher).toHaveBeenCalledTimes(1); expect(privatePackage).not.toHaveBeenCalled();
  const evidence = JSON.parse(await readFile(path.join(uploadDir, "evidence-manifest.json"), "utf8"));
  expect(evidence.files).not.toContain("html-report/trace/playwright-logo.svg");
  await expect(readFile(path.join(uploadDir, "html-report/trace/playwright-logo.svg"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(path.join(f.cell, "snapshots/manual-original-framework-result.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("actual launcher private package failure preserves original bytes and never falls back to ordinary publication", async () => {
  const f = await fixture(), original = await readFile(path.join(f.cell, "result.json"));
  const fail = vi.fn<typeof packageEvidence>().mockRejectedValue(new Error("synthetic private packaging failure"));
  const { branch, publisher } = await actualLauncherEvidenceBranch(fail);
  await expect(branch(f.context, { id: f.id }, f.cell, path.join(f.root, "results"), f.upload, [], failedLauncherResult(f.id), path.join(f.cell, "result.json"))).rejects.toThrow("synthetic private packaging failure");
  expect(fail).toHaveBeenCalledTimes(1); expect(publisher).not.toHaveBeenCalled();
  expect(await readFile(path.join(f.cell, "snapshots/manual-original-framework-result.json"))).toEqual(original);
  await expect(readFile(path.join(f.upload, "result.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
