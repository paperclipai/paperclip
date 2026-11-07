import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import RetryReporter, { annotation, flakyRecord, summaryMarkdown } from "./retry-reporter.mjs";
import { retryReporterEnabled, vitestRetryArgs, vitestRetryCount } from "./vitest-retry.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const reporterPath = fileURLToPath(new URL("./retry-reporter.mjs", import.meta.url));
const pr = { GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: "PR" };

function testCase({ state = "passed", retryCount = 0, file = path.join(root, "server/src/a.test.ts"), name = "suite > case", line } = {}) {
  return {
    fullName: name,
    module: { moduleId: file },
    project: { name: "@paperclipai/server" },
    location: line === undefined ? undefined : { line, column: 3 },
    result: () => ({ state }),
    diagnostic: () => ({ retryCount }),
  };
}

test("retry defaults to one only in the PR workflow on GitHub Actions", () => {
  assert.equal(vitestRetryCount({}), 0);
  assert.equal(vitestRetryCount(pr), 1);
  for (const workflow of ["Release", "Release Verify", "Cloud readiness", "Release Smoke", "Trusted PR CI", "Incremental CI qualification"]) {
    assert.equal(vitestRetryCount({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: workflow }), 0, workflow);
  }
  assert.equal(vitestRetryCount({ GITHUB_WORKFLOW: "PR" }), 0, "a local shell that happens to set the name stays at 0");
  assert.deepEqual(vitestRetryArgs({}), []);
  assert.deepEqual(vitestRetryArgs(pr), ["--retry=1"]);
});

test("PAPERCLIP_VITEST_RETRY overrides the default and rejects invalid values", () => {
  assert.equal(vitestRetryCount({ ...pr, PAPERCLIP_VITEST_RETRY: "0" }), 0);
  assert.deepEqual(vitestRetryArgs({ ...pr, PAPERCLIP_VITEST_RETRY: "0" }), []);
  assert.equal(vitestRetryCount({ ...pr, PAPERCLIP_VITEST_RETRY: "" }), 1, "an unset repository variable keeps the PR default");
  assert.equal(vitestRetryCount({ ...pr, PAPERCLIP_VITEST_RETRY: "  " }), 1);
  assert.equal(vitestRetryCount({ PAPERCLIP_VITEST_RETRY: "2" }), 2);
  for (const value of ["-1", "1.5", "yes"]) {
    assert.throws(() => vitestRetryCount({ PAPERCLIP_VITEST_RETRY: value }), /non-negative integer/, value);
  }
});

test("the reporter loads in GitHub Actions jobs and wherever retry is on", () => {
  assert.equal(retryReporterEnabled({}), false);
  assert.equal(retryReporterEnabled({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: "Release" }), true);
  assert.equal(retryReporterEnabled({ PAPERCLIP_VITEST_RETRY: "1" }), true);
});

test("only passes that needed a retry are flaky records", () => {
  assert.equal(flakyRecord(testCase()), null);
  assert.equal(flakyRecord(testCase({ state: "failed", retryCount: 1 })), null);
  assert.equal(flakyRecord(testCase({ state: "skipped", retryCount: 1 })), null);
  assert.deepEqual(flakyRecord(testCase({ retryCount: 1, line: 12 })), {
    file: "server/src/a.test.ts", line: 12, name: "suite > case", project: "@paperclipai/server", retries: 1,
  });
});

test("annotations escape workflow-command separators", () => {
  const record = flakyRecord(testCase({ retryCount: 2, file: path.join(root, "ui/src/a,b:c.test.ts"), name: "50% > line\nbreak" }));
  assert.equal(record.line, null);
  assert.equal(annotation(record),
    "::warning file=ui/src/a%2Cb%3Ac.test.ts,title=Flaky test passed on retry::50%25 > line%0Abreak (retried 2)");
  assert.equal(annotation({ ...record, line: 7 }),
    "::warning file=ui/src/a%2Cb%3Ac.test.ts,line=7,title=Flaky test passed on retry::50%25 > line%0Abreak (retried 2)");
});

test("the step summary is a Markdown table with the job name", () => {
  assert.equal(summaryMarkdown([]), "");
  const markdown = summaryMarkdown([{ file: "server/src/a.test.ts", name: "a | b\nc", retries: 1 }], "General tests (server 1/4)");
  assert.equal(markdown, [
    "",
    "### Flaky tests passed on retry",
    "",
    "| File | Test | Retries | Job |",
    "| --- | --- | --- | --- |",
    "| `server/src/a.test.ts` | a \\| b c | 1 | General tests (server 1/4) |",
    "", ""].join("\n"));
  assert.match(summaryMarkdown([{ file: "f", name: "n", retries: 1 }]), /\| 1 \| - \|$/m);
});

test("the reporter writes nothing for a clean run and both outputs for a flaky one", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "retry-reporter-"));
  try {
    const summary = path.join(directory, "summary.md");
    let output = "";
    const reporter = new RetryReporter({ env: { GITHUB_STEP_SUMMARY: summary, GITHUB_JOB: "general" }, root, write: (text) => { output += text; } });
    reporter.onTestRunStart();
    reporter.onTestCaseResult(testCase());
    reporter.onTestRunEnd();
    assert.equal(output, "");
    assert.throws(() => readFileSync(summary), { code: "ENOENT" });

    reporter.onTestRunStart();
    reporter.onTestCaseResult(testCase({ retryCount: 1 }));
    reporter.onTestCaseResult(testCase({ state: "failed", retryCount: 1, name: "still failing" }));
    reporter.onTestRunEnd();
    assert.equal(output, "::warning file=server/src/a.test.ts,title=Flaky test passed on retry::suite > case (retried 1)\n");
    assert.match(readFileSync(summary, "utf8"), /^\| `server\/src\/a\.test\.ts` \| suite > case \| 1 \| general \|$/m);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function runFlakyFixture(env) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "retry-reporter-vitest-")));
  symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
  // The counter lives on disk because a retry reruns the case in the same worker.
  writeFileSync(path.join(directory, "flaky.test.mjs"), `import { existsSync, writeFileSync } from "node:fs";
import { test } from "vitest";
test("fails on its first attempt", () => {
  const marker = new URL("./attempted", import.meta.url);
  if (!existsSync(marker)) { writeFileSync(marker, ""); throw new Error("first attempt fails"); }
});
test("always passes", () => {});
`);
  const configFile = path.join(directory, "vitest.config.mjs");
  writeFileSync(configFile, `export default ${JSON.stringify({ test: { include: ["*.test.mjs"], reporters: ["default", reporterPath] } })};`);
  const summary = path.join(directory, "summary.md");
  const childEnv = { ...process.env, ...env, GITHUB_STEP_SUMMARY: summary, GITHUB_WORKSPACE: directory, PAPERCLIP_CI_PROFILE_JOB: "probe" };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run",
    "--config", configFile, "--root", directory, ...vitestRetryArgs(childEnv)], {
    cwd: directory, encoding: "utf8", timeout: 60_000, env: childEnv,
  });
  let summaryText = "";
  try { summaryText = readFileSync(summary, "utf8"); } catch {}
  rmSync(directory, { recursive: true, force: true });
  return { result, summaryText };
}

test("a real PR-gated Vitest run retries the flake once and reports it", () => {
  const { result, summaryText } = runFlakyFixture({ ...pr, PAPERCLIP_VITEST_RETRY: "" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^::warning file=flaky\.test\.mjs,title=Flaky test passed on retry::fails on its first attempt \(retried 1\)$/m);
  assert.doesNotMatch(result.stdout, /always passes \(retried/);
  assert.match(summaryText, /^\| `flaky\.test\.mjs` \| fails on its first attempt \| 1 \| probe \|$/m);
});

test("outside the PR workflow the same flake fails without a retry", () => {
  const { result, summaryText } = runFlakyFixture({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: "Release", PAPERCLIP_VITEST_RETRY: "" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Flaky test passed on retry/);
  assert.doesNotMatch(summaryText, /Flaky tests passed on retry/);
});

test("run-vitest-stable passes --retry to vitest run only in the PR workflow", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "retry-wrapper-"));
  try {
    const bin = path.join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "pnpm"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$RETRY_ARGS_FILE"\n');
    chmodSync(path.join(bin, "pnpm"), 0o755);
    const invoke = (env) => {
      const argsFile = path.join(directory, `args-${Math.random()}`);
      const childEnv = { ...process.env, ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RETRY_ARGS_FILE: argsFile };
      for (const key of Object.keys(childEnv)) {
        if (key === "PAPERCLIP_CI_TEST_SELECTION" || key === "PAPERCLIP_CI_PROFILE" || /^PAPERCLIP_.*_TEST_DATABASE_URL$/.test(key)) delete childEnv[key];
      }
      const result = spawnSync(process.execPath, [path.join(root, "scripts/run-vitest-stable.mjs"),
        "--mode", "general", "--group", "general-workspaces-c"], { cwd: root, encoding: "utf8", env: childEnv, timeout: 60_000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return readFileSync(argsFile, "utf8").trim().split("\n");
    };
    assert.deepEqual(invoke({ ...pr, PAPERCLIP_VITEST_RETRY: "" }),
      ["exec", "vitest", "run", "--exclude", "**/dist/**", "--retry=1", "--project", "@paperclipai/db"]);
    assert.deepEqual(invoke({ ...pr, PAPERCLIP_VITEST_RETRY: "0" }),
      ["exec", "vitest", "run", "--exclude", "**/dist/**", "--project", "@paperclipai/db"]);
    assert.deepEqual(invoke({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: "Cloud readiness", PAPERCLIP_VITEST_RETRY: "" }),
      ["exec", "vitest", "run", "--exclude", "**/dist/**", "--project", "@paperclipai/db"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the Runner package config retries only in the PR workflow", () => {
  const base = { ...process.env };
  for (const key of ["GITHUB_ACTIONS", "GITHUB_WORKFLOW", "PAPERCLIP_VITEST_RETRY", "PAPERCLIP_CI_PROFILE"]) delete base[key];
  const load = (env) => {
    const childEnv = { ...base, ...env };
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      "const { default: config } = await import('./packages/paperclip-runner/vitest.config.ts');"
        + "process.stdout.write(JSON.stringify({ retry: config.test.retry ?? 0, reporters: config.test.reporters ?? [] }));"],
    { cwd: root, encoding: "utf8", env: childEnv, timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const prConfig = load({ ...pr, PAPERCLIP_VITEST_RETRY: "" });
  assert.equal(prConfig.retry, 1);
  assert.ok(prConfig.reporters.includes(reporterPath), JSON.stringify(prConfig.reporters));
  assert.equal(load({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: "Release", PAPERCLIP_VITEST_RETRY: "" }).retry, 0);
  assert.equal(load({ ...pr, PAPERCLIP_VITEST_RETRY: "0" }).retry, 0);
  assert.deepEqual(load({}), { retry: 0, reporters: [] }, "local runs keep the unmodified config");
});
