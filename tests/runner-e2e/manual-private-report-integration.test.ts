import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const transport = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));
vi.mock("./history-budget.js", async original => {
  const actual = await original<typeof import("./history-budget.js")>();
  return { ...actual, BoundedHistoryPublisher: class extends actual.BoundedHistoryPublisher {
    constructor(receipt: string) { super(receipt, async args => {
      const operation = args[1];
      if (operation === "put-object") {
        expect(args.slice(args.indexOf("--if-none-match"), args.indexOf("--if-none-match") + 2)).toEqual(["--if-none-match", "*"]);
        const key = args[args.indexOf("--key") + 1]!;
        expect(transport.objects.has(key)).toBe(false);
        transport.objects.set(key, await readFile(args[args.indexOf("--body") + 1]!));
        return { stdout: JSON.stringify({ VersionId: `synthetic-version-${transport.objects.size}` }) };
      }
      if (operation === "get-object-lock-configuration" || operation === "get-bucket-replication")
        throw new Error(`(${operation === "get-object-lock-configuration" ? "ObjectLockConfigurationNotFoundError" : "ReplicationConfigurationNotFoundError"})`);
      const configurations: Record<string, unknown> = {
        "get-bucket-versioning": { Status: "Enabled" },
        "get-bucket-lifecycle-configuration": { Rules: [
          { Status: "Enabled", Filter: { Prefix: "runner-e2e-private/bounded-v1/" }, Expiration: { Days: 30 }, NoncurrentVersionExpiration: { NoncurrentDays: 1 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
          { Status: "Enabled", Filter: { Prefix: "runner-e2e-private/bounded-v1/" }, Expiration: { ExpiredObjectDeleteMarker: true } },
        ] },
        "get-public-access-block": { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } },
        "get-bucket-ownership-controls": { OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] } },
        "get-bucket-policy": { Policy: JSON.stringify({ Statement: [{ Effect: "Deny" }] }) },
      };
      if (!(operation! in configurations)) throw new Error("Unexpected synthetic transport operation");
      return { stdout: JSON.stringify(configurations[operation!]) };
    }); }
  } };
});
import { stageDashboardBrandAssets } from "./report-assets.js";
import { renderRunnerE2EDashboard } from "./dashboard.js";
import { archivePrivateEvidence, privateArtifactKey } from "./private-history.js";
import { canonicalGeneratedReportAsset } from "./manual-private-report-assets.js";
import { uploadReport } from "./manual-private-transfer.js";
import { MANUAL_PRIVATE_EXECUTIONS, MANUAL_PRIVATE_PROTOCOL } from "./manual-private-retention.js";
const roots: string[] = [];
afterEach(async () => { transport.objects.clear(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("archives the actual synthetic Node-only Playwright and dashboard producers with immutable byte-bound receipts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-private-report-")); roots.push(root);
  const source = path.join(root, "report"), tests = path.join(root, "node-tests"), trace = path.join(root, "synthetic-trace");
  await Promise.all([mkdir(source), mkdir(tests), mkdir(trace)]);
  await writeFile(path.join(trace, "trace.trace"), '{"synthetic":true}\n');
  const traceZip = path.join(root, "synthetic-trace.zip"); await archivePrivateEvidence("pack", trace, traceZip);
  const require = createRequire(import.meta.url), testPackage = require.resolve("@playwright/test/package.json"), testEntry = require.resolve("@playwright/test");
  expect(JSON.parse(await readFile(testPackage, "utf8")).version).toBe("1.62.1");
  await writeFile(path.join(tests, "synthetic-node-report.spec.cjs"), `const {test,expect}=require(${JSON.stringify(testEntry)});test('synthetic Node metadata only',async({},info)=>{expect(1).toBe(1);await info.attach('trace',{path:${JSON.stringify(traceZip)},contentType:'application/zip'});});`);
  const config = path.join(tests, "synthetic.config.cjs");
  await writeFile(config, `module.exports=${JSON.stringify({ testDir: tests, testMatch: "synthetic-node-report.spec.cjs", workers: 1, use: { trace: "off" }, reporter: [["html", { outputFolder: path.join(source, "html"), open: "never" }], ["junit", { outputFile: path.join(source, "playwright-junit.xml") }], ["blob", { outputDir: path.join(source, "blob-report") }]] })};`);
  await promisify(execFile)(process.execPath, [path.join(path.dirname(testPackage), "cli.js"), "test", "--config", config], {
    cwd: tests, timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, CI: "1", NODE_OPTIONS: "", NODE_PATH: "", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
  });
  const normalized = path.join(source, "normalized"); await mkdir(normalized); await stageDashboardBrandAssets(normalized);
  const dashboard = renderRunnerE2EDashboard({ title: "Synthetic private-retention metadata", generatedAt: "2026-10-29T00:00:00Z", expected: [], catalog: [], entries: [] });
  await writeFile(path.join(normalized, "index.html"), dashboard);
  const workflowSha = "a".repeat(40), targetSha = "b".repeat(40), id = MANUAL_PRIVATE_EXECUTIONS[0]!;
  await writeFile(path.join(root, "manual-report-input-completeness.json"), JSON.stringify({ meaning: "available-files-and-transfer-only", doesNotAttestFeatureOutcome: true, cells: [{ executionId: id, availableFileInventoryComplete: true, requiredPassEvidenceComplete: null, missingRequiredEvidence: [] }] }));
  await uploadReport({ MANUAL_PRIVATE_IDS: JSON.stringify([id]), MANUAL_PRIVATE_APPROVALS_JSON: JSON.stringify({ version: 1, approvals: [{ workflowSha, targetSha, runId: "123", attempt: "1", executionIds: [id], protocol: MANUAL_PRIVATE_PROTOCOL, launchSha256: "c".repeat(64) }] }), GITHUB_SHA: workflowSha, TARGET_SHA: targetSha, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", RUNNER_E2E_PRIVATE_HISTORY_S3_BUCKET: "private-bucket", PRIVATE_REPORT_ROOT: root, PRIVATE_REPORT_SOURCE: source, AWS_ACCESS_KEY_ID: "synthetic-access-123456", AWS_SECRET_ACCESS_KEY: "synthetic-secret-123456", AWS_SESSION_TOKEN: "synthetic-session-123456" });
  const key = privateArtifactKey("manual-report", "123"), archive = transport.objects.get(key)!;
  expect(transport.objects.size).toBe(2); expect(archive).toBeInstanceOf(Buffer);
  const receipt = JSON.parse(transport.objects.get(`${key}.upload-receipt.json`)!.toString());
  expect(receipt.transfer).toMatchObject({ status: "complete", sha256: createHash("sha256").update(archive).digest("hex"), versionId: "synthetic-version-1" });
  expect(receipt.evidenceCompleteness.doesNotAttestFeatureOutcome).toBe(true);
  const archivePath = path.join(root, "retained.zip"), restored = path.join(root, "restored"); await writeFile(archivePath, archive); await archivePrivateEvidence("unpack", archivePath, restored);
  const inventory = JSON.parse(await readFile(path.join(restored, "result-evidence-inventory.json"), "utf8"));
  for (const name of ["normalized/assets/InterVariable.woff2", "html/trace/playwright-logo.svg", "html/trace/manifest.webmanifest"]) {
    const actual = await readFile(path.join(restored, "html-report", name));
    expect(actual.equals(await readFile(canonicalGeneratedReportAsset(name)!))).toBe(true);
    expect(inventory.files).toContainEqual({ path: name, bytes: actual.length, sha256: createHash("sha256").update(actual).digest("hex") });
  }
  expect(inventory.files.some((row: { path: string }) => row.path.endsWith(".ttf"))).toBe(true);
  expect(await readFile(path.join(restored, "html-report/normalized/index.html"), "utf8")).toBe(dashboard);
}, 60_000);
