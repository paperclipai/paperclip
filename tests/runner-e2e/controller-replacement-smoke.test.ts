import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { upgradeArtifactKey } from "./upgrade-artifacts.js";
import { runnerE2ETypeScriptProcessArgs } from "./web-server-command.js";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

it.each(["invalid-database-url", "postgres://fixture:fixture@127.0.0.1:1/fixture?connect_timeout=1", "invalid-outage", "invalid-manifest"])(
  "retains failed replacement evidence when setup rejects %s", async connectionString => {
    const configRoot = await mkdtemp(path.join(tmpdir(), "replacement-config-"));
    const manifest = path.join(configRoot, "malformed.json");
    await writeFile(manifest, "{broken JSON");
    const fixtureEnv: NodeJS.ProcessEnv = { ...process.env, PAPERCLIP_TEST_DATABASE_URL: connectionString,
      [upgradeArtifactKey]: undefined };
    if (connectionString === "invalid-outage") fixtureEnv.PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS = "invalid";
    if (connectionString === "invalid-manifest") fixtureEnv[upgradeArtifactKey] = manifest;
    let output = "", exitCode: unknown;
    try {
      await execute(process.execPath, runnerE2ETypeScriptProcessArgs(repositoryRoot,
        path.join(import.meta.dirname, "controller-replacement-smoke.ts")), {
        cwd: repositoryRoot, timeout: 20_000,
        env: fixtureEnv,
      });
    } catch (error) {
      const failure = error as Error & { stdout: string; code: unknown };
      output = failure.stdout; exitCode = failure.code;
    }
    await rm(configRoot, { recursive: true, force: true });
    const started = output.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line))
      .find(value => value.started === true);
    expect(started?.evidence).toEqual(expect.any(String));
    const temporaryRoot = path.dirname(started.evidence);
    expect(path.basename(temporaryRoot)).toMatch(/^paperclip-runner-e2e-/);
    try {
      expect(exitCode).toBe(1);
      const report = JSON.parse(await readFile(started.evidence, "utf8"));
      expect(report).toMatchObject({ schema: "paperclip.e2e.controller-replacement-smoke/v1",
        passed: false, providerTurns: 0, activeAgentContinuityQualified: false,
        databaseCreated: false, wrapperStarted: false, cleanupConfirmed: true,
        error: expect.any(String) });
      if (connectionString === "invalid-outage") expect(report.error).toContain("Invalid PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS");
      if (connectionString === "invalid-manifest") expect(report.error).toMatch(/JSON/);
      expect(report.replacements).toBeUndefined();
      expect(output).toContain('"passed":false');
    } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
  });
