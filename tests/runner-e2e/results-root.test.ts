import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { publishRunnerE2EAttemptEvidence } from "./evidence.js";
import { prepareRunnerE2ECampaignDirectory, resolveRunnerE2EResultsRoot, RUNNER_E2E_RESULTS_ROOT } from "./results-root.js";
import type { RunnerE2EResult } from "./types.js";
import { MANUAL_PRIVATE_PROTOCOL } from "./manual-private-retention.js";
import { inspectCellReportProducer } from "./manual-private-report-assets.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "runner-output-test-")));
  roots.push(root);
  const repository = path.join(root, "checkout");
  const privateDir = path.join(repository, "temporary", "case");
  await mkdir(privateDir, { recursive: true });
  const resultsRoot = resolveRunnerE2EResultsRoot(repository, { [RUNNER_E2E_RESULTS_ROOT]: path.join(root, "durable") });
  const campaignDir = await prepareRunnerE2ECampaignDirectory(resultsRoot, "unique-campaign");
  const uploadDir = path.join(campaignDir, "suite", "profile", "local", "case", "attempt-1");
  return { root, repository, privateDir, resultsRoot, uploadDir };
}

function result(status: "passed" | "failed" = "passed"): RunnerE2EResult {
  return {
    schema: "paperclip.runner-e2e.result/v2", executionId: "suite.profile.local.case",
    suiteId: "suite", profileId: "profile", environmentId: "local", caseId: "case",
    attempt: 1, provider: "fixture", model: "fixture", runtimeMode: "native", status,
    startedAt: "2026-10-29T00:00:00Z", finishedAt: "2026-10-29T00:00:01Z",
    durationMs: 1000, cleanup: status === "passed" ? "passed" : "not_started",
    ...(status === "failed" ? { failureClass: "permanent_infrastructure", error: "startup failed" } : {}),
  };
}

async function completeEvidence(privateDir: string) {
  for (const directory of ["snapshots", "html-report", "blob-report"])
    await mkdir(path.join(privateDir, directory));
  await writeFile(path.join(privateDir, "final-state.png"), "synthetic-test-png");
  await writeFile(path.join(privateDir, "junit.xml"), "<testsuite/>\n");
  await writeFile(path.join(privateDir, "html-report/index.html"), "<p>fixture</p>");
  await writeFile(path.join(privateDir, "snapshots/fixtures.json"), "{}\n");
  await writeFile(path.join(privateDir, "snapshots/api-state.json"), "{}\n");
  const blob = path.join(privateDir, "blob-report");
  await writeFile(path.join(blob, "report.txt"), "fixture report\n");
  execFileSync("zip", ["-q", "report.zip", "report.txt"], { cwd: blob });
}

it("publishes the real final evidence package outside the checkout and survives its removal", async () => {
  const f = await fixture();
  await completeEvidence(f.privateDir);
  expect(await publishRunnerE2EAttemptEvidence({ ...f, result: result(), secrets: [] })).toMatchObject({ status: "passed", cleanup: "passed" });
  await rm(f.repository, { recursive: true, force: true });
  expect(JSON.parse(await readFile(path.join(f.uploadDir, "result.json"), "utf8"))).toMatchObject({ status: "passed", cleanup: "passed" });
  const manifest = JSON.parse(await readFile(path.join(f.uploadDir, "evidence-manifest.json"), "utf8"));
  expect(manifest.missing).toEqual([]);
  expect(manifest.files).toEqual(expect.arrayContaining(["final-state.png", "snapshots/fixtures.json", "blob-report/report.zip"]));
  expect((await stat(f.resultsRoot)).mode & 0o777).toBe(0o700);
});

it("retains an early failure without requiring successful-flow evidence", async () => {
  const f = await fixture();
  await writeFile(path.join(f.privateDir, "server.log"), "startup failed\n");
  await publishRunnerE2EAttemptEvidence({ ...f, result: result("failed"), secrets: [] });
  await rm(f.repository, { recursive: true, force: true });
  const text = await readFile(path.join(f.uploadDir, "result.json"), "utf8");
  expect(JSON.parse(text)).toMatchObject({ status: "failed", failureClass: "permanent_infrastructure", cleanup: "not_started" });
  expect(await readFile(path.join(f.uploadDir, "server.log"), "utf8")).toBe("startup failed\n");
});

it("still rejects and redacts leaked diagnostics at the external destination", async () => {
  const f = await fixture(), secret = "synthetic-private-fixture-credential";
  await writeFile(path.join(f.privateDir, "server.log"), `startup failed: ${secret}\n`);
  await publishRunnerE2EAttemptEvidence({ ...f, result: { ...result("failed"), error: `startup failed: ${secret}` }, secrets: [secret] });
  const text = await readFile(path.join(f.uploadDir, "result.json"), "utf8");
  expect(JSON.parse(text)).toMatchObject({ status: "failed", failureClass: "secret_leak", cleanup: "not_started" });
  expect(text).not.toContain(secret);
  expect(await readFile(path.join(f.uploadDir, "server.log"), "utf8")).toContain("[REDACTED]");
});

it("still fails a nominal pass when required evidence is missing at the external destination", async () => {
  const f = await fixture();
  await completeEvidence(f.privateDir);
  await rm(path.join(f.privateDir, "final-state.png"));
  const final = await publishRunnerE2EAttemptEvidence({ ...f, result: result(), secrets: [] });
  expect(final).toMatchObject({ status: "failed", failureClass: "permanent_infrastructure", error: "Required evidence missing: final-state.png" });
  expect(JSON.parse(await readFile(path.join(f.uploadDir, "result.json"), "utf8"))).toEqual(final);
});

it("preserves the default and rejects unsafe override roots before any output or provider admission", async () => {
  const f = await fixture();
  expect(resolveRunnerE2EResultsRoot(f.repository, {})).toBe(path.join(f.repository, "tests/runner-e2e/results"));
  const alias = path.join(f.root, "alias");
  await symlink(f.resultsRoot, alias);
  const file = path.join(f.root, "file");
  await writeFile(file, "not a directory");
  for (const unsafe of ["", "relative", `${f.root}/missing/../other`, path.parse(f.root).root,
    os.homedir(), f.repository, path.join(f.repository, "source"), path.dirname(f.repository), alias, path.join(alias, "child"), file]) {
    expect(() => resolveRunnerE2EResultsRoot(f.repository, { [RUNNER_E2E_RESULTS_ROOT]: unsafe })).toThrow(RUNNER_E2E_RESULTS_ROOT);
  }
});

it("denies traversal and symlink destinations before deleting or writing final evidence", async () => {
  const f = await fixture();
  for (const unsafe of [".", "..", "../outside", "one/two", ""])
    await expect(prepareRunnerE2ECampaignDirectory(f.resultsRoot, unsafe)).rejects.toThrow("safe path segment");
  const outside = path.join(f.root, "outside");
  await mkdir(path.join(outside, "attempt-1"), { recursive: true });
  const sentinel = path.join(outside, "attempt-1", "sentinel.txt");
  await writeFile(sentinel, "preserve me");
  await symlink(outside, path.join(f.resultsRoot, "alias-campaign"));
  await expect(prepareRunnerE2ECampaignDirectory(f.resultsRoot, "alias-campaign")).rejects.toThrow("physical directories");
  await symlink(outside, path.join(f.resultsRoot, "unique-campaign", "alias-profile"));
  const uploadDir = path.join(f.resultsRoot, "unique-campaign", "alias-profile", "attempt-1");
  await expect(publishRunnerE2EAttemptEvidence({ ...f, uploadDir, result: result("failed"), secrets: [] })).rejects.toThrow("physical directories");
  await expect(publishRunnerE2EAttemptEvidence({ ...f, uploadDir: outside, result: result("failed"), secrets: [] })).rejects.toThrow("beneath its results root");
  expect(await readFile(sentinel, "utf8")).toBe("preserve me");
});

it("allows a normal retry in the same physical campaign", async () => {
  const f = await fixture();
  await completeEvidence(f.privateDir);
  await publishRunnerE2EAttemptEvidence({ ...f, result: result(), secrets: [] });
  expect(await prepareRunnerE2ECampaignDirectory(f.resultsRoot, "unique-campaign")).toBe(path.join(f.resultsRoot, "unique-campaign"));
  await publishRunnerE2EAttemptEvidence({ ...f, result: result("failed"), secrets: [] });
  expect(JSON.parse(await readFile(path.join(f.uploadDir, "result.json"), "utf8"))).toMatchObject({ status: "failed", error: "startup failed" });
});

async function shadowLauncher(dotenv: string, host?: { platform: NodeJS.Platform; arch: string }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "runner-dotenv-output-")));
  roots.push(root);
  const repository = path.join(root, "checkout"), directory = path.join(repository, "tests/runner-e2e");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(repository, "package.json"), '{"type":"module"}');
  let source = await readFile(path.join(import.meta.dirname, "launch.ts"), "utf8");
  if (host) source = source.replaceAll("assertRunnerE2EPrerequisites(executions);",
    `assertRunnerE2EPrerequisites(executions, ${JSON.stringify(host)});`);
  await writeFile(path.join(directory, "launch.ts"), source);
  for (const entry of await readdir(import.meta.dirname, { withFileTypes: true })) {
    if (["launch.ts", "results"].includes(entry.name)) continue;
    await symlink(path.join(import.meta.dirname, entry.name), path.join(directory, entry.name), entry.isDirectory() ? "dir" : "file");
  }
  const output = path.join(root, "dotenv-reports"), home = path.join(root, "empty-home");
  await mkdir(home);
  await writeFile(path.join(repository, ".env.runner-e2e.local"), dotenv.replaceAll("OUTPUT_ROOT", output));
  async function launch(args: string[], environment: NodeJS.ProcessEnv = {}) {
    try {
      return { code: 0, ...await promisify(execFile)(process.execPath,
        ["--import", path.resolve(import.meta.dirname, "../../cli/node_modules/tsx/dist/loader.mjs"), path.join(directory, "launch.ts"), ...args],
        { cwd: repository, timeout: 20_000, env: { PATH: process.env.PATH, HOME: home, PAPERCLIP_E2E_CAMPAIGN_ID: "dotenv-probe", ...environment } }) };
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    }
  }
  return { root, repository, output, launch };
}

it("rejects unsupported local Kimi provider loss before the actual launcher reads dotenv or creates resources", async () => {
  const f = await shadowLauncher("KIMI_API_KEY=synthetic-never-read\n", { platform: "linux", arch: "x64" });
  const probe = path.join(f.root, "deny-dotenv-read.mjs"), marker = path.join(f.root, "dotenv-read-attempted");
  await writeFile(probe, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.promises.readFile;
fs.promises.readFile = async (...args) => {
  if (String(args[0]) === process.env.TEST_DOTENV_PATH) {
    await fs.promises.writeFile(process.env.TEST_DOTENV_MARKER, "read attempted\\n");
    throw new Error("forbidden dotenv credential read");
  }
  return original(...args);
};
syncBuiltinESMExports();
`);
  const result = await f.launch(["--id", "kimi-qualification.runner-acpx-kimi.local.native-write-provider-loss"], {
    NODE_OPTIONS: `--import=${probe}`, TEST_DOTENV_PATH: path.join(f.repository, ".env.runner-e2e.local"), TEST_DOTENV_MARKER: marker,
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Local native Kimi provider-loss");
  expect(result.stderr).toContain("No provider credentials were loaded or sent");
  expect(result.stderr).not.toContain("forbidden dotenv credential read");
  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(path.join(f.repository, "tests/runner-e2e/results"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("uses the actual dotenv output root before a normal native campaign fails credential admission", async () => {
  const f = await shadowLauncher("export PAPERCLIP_RUNNER_E2E_RESULTS_ROOT='OUTPUT_ROOT'\n");
  const result = await f.launch(["--id", "kimi-qualification.runner-acpx-kimi.local.message-marker"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Missing runner E2E credentials: KIMI_API_KEY");
  expect((await stat(path.join(f.output, "dotenv-probe"))).isDirectory()).toBe(true);
  await expect(stat(path.join(f.repository, "tests/runner-e2e/results"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["list", "pending", "installed-startup"])("does not load dotenv in the %s admission path", async mode => {
  const f = await shadowLauncher("invalid dotenv assignment\n");
  const pending = runnerMatrix.find(row => row.profile.id === "legacy-kimi-cli")!;
  const args = mode === "list" ? ["--list", "--id", "kimi-qualification.runner-acpx-kimi.local.message-marker"]
    : mode === "pending" ? ["--id", pending.id]
    : ["--installed-startup-only", "--id", "extended-harnesses.runner-acpx-pi.local.hello-complete", "--max-automatic-retries", "0"];
  const result = await f.launch(args);
  expect(result.stderr).not.toContain("Invalid .env.runner-e2e.local");
  if (mode === "list") {
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("kimi-qualification.runner-acpx-kimi.local.message-marker");
  } else {
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(mode === "pending" ? "prerequisite(s) are pending" : "Installed startup-only requires");
  }
  await expect(stat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
});

async function verifiedPrivateLaunch(f: Awaited<ReturnType<typeof shadowLauncher>>, executionId: string) {
  const privateRoot = path.join(f.root, "verified-private"), file = path.join(privateRoot, "preflight.json");
  await mkdir(privateRoot, { mode: 0o700 });
  const identity = { workflowSha: "a".repeat(40), targetSha: "b".repeat(40), runId: "123", attempt: "1" };
  await writeFile(file, JSON.stringify({ protocol: MANUAL_PRIVATE_PROTOCOL, status: "verified", private: true,
    root: privateRoot, ...identity, executionIds: [executionId], cellReportProducer: await inspectCellReportProducer() }), { mode: 0o600 });
  return { privateRoot, environment: { PAPERCLIP_RUNNER_E2E_PRIVATE_PREFLIGHT: file, RUNNER_TEMP: f.root,
    GITHUB_SHA: identity.workflowSha, GITHUB_RUN_ID: identity.runId, GITHUB_RUN_ATTEMPT: identity.attempt,
    PAPERCLIP_RUNNER_E2E_SOURCE_SHA: identity.targetSha } };
}

it.each([
  ["process", "conflicting"], ["process", "invalid"], ["dotenv", "conflicting"], ["dotenv", "invalid"],
] as const)("actual launcher keeps verified private custody over %s %s output settings", async (origin, kind) => {
  const setting = kind === "invalid" ? "relative-invalid-root" : "OUTPUT_ROOT";
  const f = await shadowLauncher(origin === "dotenv" ? `${RUNNER_E2E_RESULTS_ROOT}='${setting}'\n` : "");
  const executionId = "kimi-qualification.runner-acpx-kimi.local.message-marker";
  const custody = await verifiedPrivateLaunch(f, executionId);
  const environment = { ...custody.environment,
    ...(origin === "process" ? { [RUNNER_E2E_RESULTS_ROOT]: kind === "invalid" ? setting : f.output } : {}) };
  const result = await f.launch(["--id", executionId], environment);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Missing runner E2E credentials: KIMI_API_KEY");
  expect(result.stderr).not.toContain("requires a normalized absolute directory");
  expect((await stat(path.join(custody.privateRoot, "results/dotenv-probe"))).isDirectory()).toBe(true);
  expect(result.stderr).toContain("Private evidence finalization failed; no public fallback");
  for (const output of [f.output, path.join(f.repository, "tests/runner-e2e/results")])
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
});

it("actual launcher rejects foreign private custody before reading dotenv or creating fallback output", async () => {
  const f = await shadowLauncher("invalid dotenv assignment\n");
  const executionId = "kimi-qualification.runner-acpx-kimi.local.message-marker";
  const custody = await verifiedPrivateLaunch(f, executionId);
  const result = await f.launch(["--id", executionId], { ...custody.environment, GITHUB_RUN_ID: "124" });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Private evidence preflight does not match this exact attempt");
  expect(result.stderr).not.toContain("Invalid .env.runner-e2e.local");
  for (const output of [path.join(custody.privateRoot, "results"), f.output, path.join(f.repository, "tests/runner-e2e/results")])
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
});
