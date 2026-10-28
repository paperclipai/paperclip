import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DEPENDABLE_CELLS, dependableDailySelection, dependableDailyExecutions, dependableExecutionId, dependableRequiredChecks, gradeDependableQualification, gradeRetainedDependableResults,
  type DependableAttempt, type DependableCell, type DependableQualification } from "./dependable-qualification.js";
import { validateRetainedRunnerResult } from "./result-validation.js";

const hash = "a".repeat(64);
const config: DependableQualification = { revision: "b".repeat(40), startedAt: "2026-10-20T00:00:00Z", candidatePassesPerCell: 3,
  settingsHashes: { codie: hash, claude: hash }, models: { codie: "codie-recorded-model", claude: "claude-recorded-model" },
  instructionsHash: hash, definitionHash: hash, runnerArtifact: `sha256:${hash}` };
function attempt(cell: DependableCell, index: number, phase: "candidate" | "staging" = "candidate"): DependableAttempt {
  const identity = `${cell}-${index}-${phase}`;
  return { campaignId: `campaign-${identity}`, cell, phase,
    result: { schema: "paperclip.runner-e2e.result/v2", executionId: dependableExecutionId(cell), suiteId: "dependable-work",
      suiteDefinitionHash: hash, source: { sha: config.revision, ref: "refs/heads/candidate", workflowRunUrl: null },
      attempt: 1, status: "passed", profileId: cell.startsWith("codie.") ? "codie" : "claude", environmentId: "daytona",
      caseId: cell.split(".").slice(1).join("-"), provider: cell.startsWith("codie.") ? "codex" : "acpx", model: config.models[cell.startsWith("codie.") ? "codie" : "claude"],
      runtimeMode: "native", issueId: `issue-${identity}`, runIds: [`run-${identity}`],
      startedAt: `2026-10-20T00:0${index}:00Z`, finishedAt: `2026-10-20T00:0${index}:30Z`, durationMs: 30_000, cleanup: "passed",
      matcherResults: dependableRequiredChecks(cell).map(path => ({ matcher: { kind: "json_path", path, expected: true }, passed: true, detail: "Independent observer receipt" })) },
    evidence: { manifestVerified: true, secretScanPassed: true, definitionHash: hash, settingsHash: hash, instructionsHash: hash,
      runnerArtifact: `sha256:${hash}`, revisionAtStart: config.revision, revisionAtEnd: config.revision,
      target: phase === "staging" ? "isolated-staging" : "isolated-candidate" } };
}
const complete = () => DEPENDABLE_CELLS.flatMap(cell => [attempt(cell, 1), attempt(cell, 2), attempt(cell, 3), attempt(cell, 4, "staging")]);

it("requires 72 fresh candidate passes plus subsequent deployed proof for all 24 cells", () => {
  expect(DEPENDABLE_CELLS).toHaveLength(24);
  const report = gradeDependableQualification(config, complete());
  expect(report.complete).toBe(true);
  expect(report.cells.every(cell => cell.candidatePassed === 3 && cell.stagingPassedAfterCheckpoint === 1)).toBe(true);
});

it("does not convert a partial green pilot into full qualification", () => {
  const report = gradeDependableQualification(config, [attempt(DEPENDABLE_CELLS[0]!, 1)]);
  expect(report.complete).toBe(false);
  expect(report.observations[0]!.qualified).toBe(true);
  expect(report.cells.filter(cell => cell.candidatePassed > 0)).toHaveLength(1);
});

it("does not treat candidate passes or an earlier deployment as subsequent staging proof", () => {
  const rows = complete().map(row => row.phase === "staging" ? attempt(row.cell, 0, "staging") : row);
  expect(gradeDependableQualification(config, rows).complete).toBe(false);
  expect(gradeDependableQualification(config, rows.filter(row => row.phase === "candidate")).complete).toBe(false);
});

it("retains a failed original attempt after fresh passing attempts", () => {
  const failed = attempt(DEPENDABLE_CELLS[0]!, 0); failed.result.status = "failed";
  const report = gradeDependableQualification(config, [failed, ...complete()]);
  expect(report.complete).toBe(true);
  expect(report.failedAttempts).toBe(1);
  expect(report.observations[0]!.originalStatus).toBe("failed");
  expect(report.observations[0]!.problems).toContain("failed-attempt");
});

it.each([
  ["green badge without independent checks", (row: DependableAttempt) => { row.result.matcherResults = []; }],
  ["agent claim instead of a receipt", (row: DependableAttempt) => { row.result.matcherResults = [{ matcher: { kind: "message_contains", expected: "all passed" }, passed: true, detail: "all passed" }]; }],
  ["missing delivery receipt", (row: DependableAttempt) => { row.result.matcherResults!.splice(2, 1); }],
  ["failed output oracle", (row: DependableAttempt) => { row.result.matcherResults![3]!.passed = false; }],
  ["different provider model", (row: DependableAttempt) => { row.result.model = "development-default"; }],
  ["legacy execution", (row: DependableAttempt) => { row.result.runtimeMode = "legacy"; }],
  ["relabeled development execution", (row: DependableAttempt) => { row.result.executionId = "automatic-repository.runner-codex.local.automatic-repository-resume"; }],
  ["stale effective settings", (row: DependableAttempt) => { row.evidence.settingsHash = "c".repeat(64); }],
  ["different instructions", (row: DependableAttempt) => { row.evidence.instructionsHash = "c".repeat(64); }],
  ["unidentified runner artifact", (row: DependableAttempt) => { row.evidence.runnerArtifact = "unknown"; }],
  ["deployment drift during work", (row: DependableAttempt) => { row.evidence.revisionAtEnd = "c".repeat(40); }],
  ["wrong source", (row: DependableAttempt) => { row.result.source!.sha = "c".repeat(40); }],
  ["dirty source", (row: DependableAttempt) => { row.result.source!.ref += " (working tree)"; }],
  ["different case definition", (row: DependableAttempt) => { row.result.suiteDefinitionHash = "c".repeat(64); }],
  ["missing manifest validation", (row: DependableAttempt) => { row.evidence.manifestVerified = false; }],
  ["credential leak", (row: DependableAttempt) => { row.evidence.secretScanPassed = false; }],
  ["unfinished cleanup", (row: DependableAttempt) => { row.result.cleanup = "failed"; }],
  ["historical attempt", (row: DependableAttempt) => { row.result.startedAt = "2026-10-19T23:59:00Z"; }],
] as const)("rejects %s", (_name, mutate) => {
  const rows = complete(); mutate(rows[0]!);
  const report = gradeDependableQualification(config, rows);
  expect(report.complete).toBe(false);
  expect(report.observations[0]!.qualified).toBe(false);
});

it("rejects duplicate receipts instead of counting one run twice", () => {
  const row = attempt(DEPENDABLE_CELLS[0]!, 1);
  const report = gradeDependableQualification(config, [row, structuredClone(row)]);
  expect(report.complete).toBe(false);
  expect(report.observations).toHaveLength(2);
  expect(report.observations.every(value => !value.qualified && value.problems.includes("duplicate-attempt-receipt"))).toBe(true);
});

it("does not count an existing task or run as a fresh attempt under a new receipt", () => {
  const rows = complete(); rows[1]!.result.issueId = rows[0]!.result.issueId;
  rows[2]!.result.runIds = rows[0]!.result.runIds;
  const report = gradeDependableQualification(config, rows);
  expect(report.complete).toBe(false);
  expect(report.observations.slice(0, 3).every(row => row.problems.includes("reused-task-or-run"))).toBe(true);
});

it("rotates explicit selections through every cell once in six UTC days", () => {
  const selections = Array.from({ length: 6 }, (_, i) => dependableDailySelection(`2026-10-${20 + i}`));
  expect(selections.every(rows => rows.length === 4)).toBe(true);
  expect([...new Set(selections.flat())].sort()).toEqual([...DEPENDABLE_CELLS].sort());
});

it.each(["2026-02-30", "today", "2026-10-20T00:00:00Z"])("rejects ambiguous rotation date %s", date => {
  expect(() => dependableDailySelection(date)).toThrow();
});

it("retains the complete report pool, including failures shadowed by later successes", () => {
  const failed = attempt(DEPENDABLE_CELLS[0]!, 0); failed.result.status = "failed";
  const entries = [failed, ...complete()].map(row => {
    const { result, ...receipt } = row;
    const { manifestVerified: _manifest, secretScanPassed: _scan, ...evidence } = receipt.evidence;
    return { result: { ...result, dependableWork: { ...receipt, evidence } }, evidence: { files: ["final-state.png"], leaks: [], missing: [] }, errors: [] };
  });
  const report = gradeRetainedDependableResults(config, entries);
  expect(report.complete).toBe(true); expect(report.observations).toHaveLength(97); expect(report.failedAttempts).toBe(1);
  entries[0]!.result.dependableWork = undefined as any;
  const incomplete = gradeRetainedDependableResults(config, entries);
  expect(incomplete.complete).toBe(false); expect(incomplete.unclassifiedResults).toHaveLength(1);
});

it("blocks scheduling until every exact daily execution exists in the catalog", () => {
  expect(() => dependableDailyExecutions("2026-10-20", [])).toThrow("not registered");
  expect(dependableDailyExecutions("2026-10-20", DEPENDABLE_CELLS.map(dependableExecutionId))).toHaveLength(4);
});

it("rejects unexpected credential-bearing metadata before retained report processing", () => {
  const row = attempt(DEPENDABLE_CELLS[0]!, 1);
  const { manifestVerified: _manifest, secretScanPassed: _scan, ...evidence } = row.evidence;
  const result = { ...row.result, dependableWork: { campaignId: row.campaignId, cell: row.cell, phase: row.phase, evidence } };
  expect(() => validateRetainedRunnerResult(result)).not.toThrow();
  expect(() => validateRetainedRunnerResult({ ...result, dependableWork: { ...result.dependableWork, credential: "not-allowed" } })).toThrow("result.dependableWork");
  expect(() => validateRetainedRunnerResult({ ...result, dependableWork: { ...result.dependableWork, evidence: { ...evidence, callbackUrl: "https://invalid.example" } } })).toThrow("result.dependableWork.evidence");
});

it("makes the actual report command fail an incomplete checkpoint while retaining an earlier failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dependable-report-"));
  try {
    const rows = [attempt(DEPENDABLE_CELLS[0]!, 0), attempt(DEPENDABLE_CELLS[0]!, 1)];
    rows[0]!.result.status = "failed";
    for (const [index, row] of rows.entries()) {
      const directory = path.join(root, `campaign-${index}`, "attempt-1"); await mkdir(directory, { recursive: true });
      const { manifestVerified: _manifest, secretScanPassed: _scan, ...evidence } = row.evidence;
      await writeFile(path.join(directory, "result.json"), JSON.stringify({ ...row.result,
        dependableWork: { campaignId: row.campaignId, cell: row.cell, phase: row.phase, evidence } }));
      await writeFile(path.join(directory, "evidence-manifest.json"), JSON.stringify({ files: ["final-state.png"], leaks: [], missing: [] }));
      await writeFile(path.join(directory, "final-state.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=", "base64"));
    }
    const manifest = path.join(root, "qualification.json"); await writeFile(manifest, JSON.stringify(config));
    const repository = path.resolve(import.meta.dirname, "../..");
    const output = path.join(root, "report");
    await expect(promisify(execFile)(process.execPath, [path.join(repository, "cli/node_modules/tsx/dist/cli.mjs"),
      path.join(repository, "tests/runner-e2e/report.ts")], { cwd: repository, timeout: 25_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PAPERCLIP_RUNNER_E2E_REPORT_ROOT: root,
        PAPERCLIP_RUNNER_E2E_REPORT_OUT: output, PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify([rows[0]!.result.executionId]),
        PAPERCLIP_DEPENDABLE_QUALIFICATION_MANIFEST: manifest } })).rejects.toMatchObject({ code: 1 });
    const report = JSON.parse(await readFile(path.join(output, "dependable-qualification.json"), "utf8"));
    expect(report.complete).toBe(false); expect(report.observations).toHaveLength(2); expect(report.failedAttempts).toBe(1);
    expect(report.cells[0].candidatePassed).toBe(1);
    expect(await readFile(path.join(output, "summary.md"), "utf8")).toContain("checkpoint: incomplete");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["constructor", "toString", "__proto__", "secret-value-in-a-field-name"])("rejects unexpected metadata keys without echoing %s", key => {
  const row = attempt(DEPENDABLE_CELLS[0]!, 1);
  const { manifestVerified: _manifest, secretScanPassed: _scan, ...evidence } = row.evidence;
  const receipt = { campaignId: row.campaignId, cell: row.cell, phase: row.phase, evidence };
  for (const dependableWork of [{ ...receipt, [key]: "untrusted" }, { ...receipt, evidence: { ...evidence, [key]: "untrusted" } }]) {
    let error: unknown;
    try { validateRetainedRunnerResult({ ...row.result, dependableWork }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("result.dependableWork");
    expect((error as Error).message).not.toContain(key);
  }
});

it("keeps a complete rotation for valid UTC dates before the Unix epoch", () => {
  const dates = ["1969-12-26", "1969-12-27", "1969-12-28", "1969-12-29", "1969-12-30", "1969-12-31"];
  expect(dates.every(date => dependableDailySelection(date).length === 4)).toBe(true);
  expect([...new Set(dates.flatMap(dependableDailySelection))].sort()).toEqual([...DEPENDABLE_CELLS].sort());
});

it.each(["missing", "duplicate", "linked", "unsafe"])("writes an incomplete report for %s retained proof", async defect => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dependable-retained-proof-"));
  try {
    const rows = complete();
    if (defect === "duplicate") rows.push(structuredClone(rows[0]!));
    for (const [index, row] of rows.entries()) {
      const directory = path.join(root, `campaign-${index}`, "attempt-1"); await mkdir(directory, { recursive: true });
      const { manifestVerified: _manifest, secretScanPassed: _scan, ...evidence } = row.evidence;
      await writeFile(path.join(directory, "result.json"), JSON.stringify({ ...row.result,
        dependableWork: { campaignId: row.campaignId, cell: row.cell, phase: row.phase, evidence } }));
      const files = defect === "unsafe" && index === 0 ? ["final-state.png", "../outside.png"] : ["final-state.png"];
      await writeFile(path.join(directory, "evidence-manifest.json"), JSON.stringify({ files, leaks: [], missing: [] }));
      if (defect === "linked" && index === 0) {
        const outside = path.join(root, "outside.png"); await writeFile(outside, "external proof");
        await symlink(outside, path.join(directory, "final-state.png"));
      } else if (defect !== "missing" || index !== 0) await writeFile(path.join(directory, "final-state.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=", "base64"));
    }
    const manifest = path.join(root, "qualification.json"); await writeFile(manifest, JSON.stringify(config));
    const repository = path.resolve(import.meta.dirname, "../.."), output = path.join(root, "report");
    let exitCode = 0;
    try {
      await promisify(execFile)(process.execPath, [path.join(repository, "cli/node_modules/tsx/dist/cli.mjs"), path.join(repository, "tests/runner-e2e/report.ts")], {
        cwd: repository, timeout: 25_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, PAPERCLIP_RUNNER_E2E_REPORT_ROOT: root,
          PAPERCLIP_RUNNER_E2E_REPORT_OUT: output, PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify([rows[0]!.result.executionId]),
          PAPERCLIP_DEPENDABLE_QUALIFICATION_MANIFEST: manifest },
      });
    } catch (error) { exitCode = (error as { code: number }).code; }
    expect(exitCode).toBe(1);
    const report = JSON.parse(await readFile(path.join(output, "dependable-qualification.json"), "utf8"));
    expect(report.complete).toBe(false);
    expect(report.observations).toHaveLength(rows.length);
    const original = report.observations.find((value: Record<string, any>) => value.campaignId === rows[0]!.campaignId);
    expect(original?.problems).toContain(defect === "duplicate" ? "duplicate-attempt-receipt" : "evidence-unverified");
    expect(await readFile(path.join(output, "summary.md"), "utf8")).toContain("checkpoint: incomplete");
    expect(await readFile(path.join(output, "index.html"), "utf8")).toContain("html");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not start a daily rotation when only today's journeys are registered", () => {
  const today = dependableDailySelection("2026-10-20").map(dependableExecutionId);
  expect(() => dependableDailyExecutions("2026-10-20", today)).toThrow("not registered");
  const all = DEPENDABLE_CELLS.map(dependableExecutionId);
  const later = all.find(id => !today.includes(id))!;
  const missingLater = all.filter(id => id !== later);
  expect(() => dependableDailyExecutions("2026-10-20", missingLater)).toThrow("not registered");
});
