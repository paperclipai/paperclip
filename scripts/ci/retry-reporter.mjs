import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A retried pass is still a flake. Keep each one visible as a GitHub warning
// annotation and a step-summary row so `retry` never hides a failure silently.
// The CI profile reporter already records `retries` per test case for traces.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export function flakyRecord(testCase, root = repoRoot) {
  if (testCase.result()?.state !== "passed") return null;
  const retries = testCase.diagnostic()?.retryCount ?? 0;
  if (!(retries > 0)) return null;
  return {
    file: path.relative(root, testCase.module.moduleId).split(path.sep).join("/"),
    line: testCase.location?.line ?? null,
    name: testCase.fullName,
    project: testCase.project?.name ?? null,
    retries,
  };
}

// GitHub workflow command escaping: data escapes %, CR and LF; property
// values additionally escape the `:` and `,` separators.
function escapeData(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(value) {
  return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

export function annotation(record) {
  const properties = [`file=${escapeProperty(record.file)}`];
  if (record.line) properties.push(`line=${record.line}`);
  properties.push(`title=${escapeProperty("Flaky test passed on retry")}`);
  return `::warning ${properties.join(",")}::${escapeData(`${record.name} (retried ${record.retries})`)}`;
}

function cell(value) {
  return String(value).replace(/\s+/g, " ").replaceAll("|", "\\|").trim();
}

export function summaryMarkdown(records, job = "") {
  if (records.length === 0) return "";
  const rows = records.map((record) => `| \`${cell(record.file)}\` | ${cell(record.name)} | ${record.retries} | ${cell(job || "-")} |`);
  // Lead with a blank line: Vitest's own job summary may end mid-list.
  return [
    "",
    "### Flaky tests passed on retry",
    "",
    "| File | Test | Retries | Job |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "",
  ].join("\n");
}

export default class RetryReporter {
  constructor({ env = process.env, root = env.GITHUB_WORKSPACE || repoRoot, write = (text) => process.stdout.write(text) } = {}) {
    this.env = env;
    this.root = root;
    this.write = write;
    this.records = [];
  }

  onTestRunStart() {
    this.records = [];
  }

  onTestCaseResult(testCase) {
    const record = flakyRecord(testCase, this.root);
    if (record) this.records.push(record);
  }

  onTestRunEnd() {
    if (this.records.length === 0) return;
    this.write(`${this.records.map(annotation).join("\n")}\n`);
    const summaryFile = this.env.GITHUB_STEP_SUMMARY;
    if (!summaryFile) return;
    try {
      appendFileSync(summaryFile, summaryMarkdown(this.records, this.env.PAPERCLIP_CI_PROFILE_JOB || this.env.GITHUB_JOB));
    } catch (error) {
      // Reporting must not change the test result; the annotations already printed.
      console.error(`retry reporter: unable to write the step summary: ${error.message}`);
    }
  }
}
