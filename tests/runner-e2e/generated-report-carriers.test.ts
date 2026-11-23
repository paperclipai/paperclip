import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertGeneratedReportCarriers } from "./manual-private-transfer.js";
import { sealManualResultEvidence, type ManualPrivateHandoff } from "./manual-private-handoff.js";
import { canonicalGeneratedReportAsset } from "./manual-private-report-assets.js";
import { MANUAL_PRIVATE_EXECUTIONS, MANUAL_PRIVATE_PROTOCOL } from "./manual-private-retention.js";
import { privateRefusalCode } from "./private-refusal-code.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function report(files: Record<string, string | Buffer>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "generated-report-carriers-")); roots.push(root);
  const source = path.join(root, "runner-e2e-merged-report");
  for (const [name, data] of Object.entries({ "html/index.html": "<html></html>", "normalized/summary.md": "summary", ...files })) {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await writeFile(path.join(source, name), data);
  }
  return { root, source };
}
const cell = "normalized/evidence/chat-features.runner-opencode.local.case/attempt-1/html-report/trace";

it("accepts standard carriers and authenticated trace viewer assets", async () => {
  const logo = await readFile(canonicalGeneratedReportAsset("html/trace/playwright-logo.svg")!);
  const { source } = await report({ "html/trace/playwright-logo.svg": logo, "html/data/0123456789abcdef0123456789abcdef01234567.zip": "zip" });
  await expect(assertGeneratedReportCarriers(source)).resolves.toBeUndefined();
});

it.each([
  [`${cell}/codicon.DCmgc-ay.ttf`, "font"],
  [`${cell}/playwright-logo.svg`, "svg"],
  [`${cell}/manifest.webmanifest`, "webmanifest"],
  ["html/data/0123456789abcdef0123456789abcdef01234567.jpeg", "image"],
  ["normalized/report.js.map", "source-map"],
  ["normalized/LICENSE", "no-extension"],
  ["normalized/archive.tar", "other"],
  ["html/trace/index.js.map", "trace-viewer-asset"],
  ["html/trace/playwright-logo.svg", "trace-viewer-bytes"],
])("names a refused %s carrier by its closed category, never its path", async (name, category) => {
  const { root, source } = await report({ [name]: "synthetic carrier" });
  const refusal = await assertGeneratedReportCarriers(source).then(() => undefined, (error: unknown) => error);
  const code = privateRefusalCode(refusal);
  expect(code).toBe(`unsupported-generated-report-carrier-${category}`);
  expect(code).not.toContain("chat-features");
  // The authoritative seal refuses the same tree, so the preflight never hides an admissible report.
  const context = { root, private: true, protocol: MANUAL_PRIVATE_PROTOCOL, workflowSha: "a".repeat(40), targetSha: "b".repeat(40), runId: "123",
    attempt: "1", executionIds: [MANUAL_PRIVATE_EXECUTIONS[0]!] } as ManualPrivateHandoff;
  await expect(sealManualResultEvidence(context, [], source, "generated-report")).rejects.toThrow("Unsupported packaged evidence carrier");
});
