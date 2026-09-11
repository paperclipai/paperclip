import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execute } from "../adapters/process/execute.js";
import { RUNNER_TIMEOUT_EXIT_CODE } from "../services/execution-resource-admission.js";

/**
 * The legacy process adapter's outcome contract for contained runners
 * (framework `paperclip.mjs`): a launcher-issued wall-clock timeout carries the
 * structured run_timeout envelope and feeds the bounded session-resuming
 * continuation, while bare codes, malformed envelopes, and foreign evidence
 * stay ordinary failures. Structured exit-1 pre-model refusals are consumed
 * from the producer contract only.
 */

const FOREIGN_RUN_ID = "11111111-1111-4111-8111-111111111111";

/** The launcher's durable run-outcome record (paperclip.mjs run-outcome.json,
 * mirrored verbatim to stdout as one line). */
function timeoutEnvelope(runId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "run_timeout",
    status: "timed_out",
    runId,
    issueId: "fc51e706-0000-4000-8000-000000000003",
    sessionId: "paperclip-fc51e706-3ae84a40a9322b59f153",
    modelStarted: true,
    resumable: true,
    progress: { requests: 99, denials: 1, lastEventAt: "2026-09-11T08:05:06.656Z" },
    exitCode: RUNNER_TIMEOUT_EXIT_CODE,
    ...overrides,
  });
}

/** Renders the launcher envelope with `runId` read from the child's own env,
 * exactly the way paperclip.mjs emits it. */
function launcherEnvelopeSource(overrides: Record<string, unknown> = {}): string {
  return `JSON.stringify(${timeoutEnvelope("__RUN_ID_ENV__", overrides)
    .replace('"__RUN_ID_ENV__"', "process.env.PAPERCLIP_RUN_ID")})`;
}

function stdoutLine(jsonSource: string): string {
  return `process.stdout.write(${jsonSource} + "\\n");`;
}

function scriptSource(body: string, exitCode: number): string {
  return [
    'process.stdout.write("mid-turn worker output\\n");',
    body,
    `process.exit(${exitCode});`,
    "",
  ].join("\n");
}

describe("process adapter runner outcome evidence", () => {
  let fixtureDir!: string;

  beforeAll(async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runner-outcome-"));
  }, 20_000);

  afterAll(async () => {
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  async function writeScript(name: string, source: string): Promise<string> {
    const scriptPath = path.join(fixtureDir, name);
    await fs.writeFile(scriptPath, source, "utf8");
    return scriptPath;
  }

  async function runProcessAdapter(input: {
    scriptPath: string;
    runId?: string;
    timeoutSec?: number;
    graceSec?: number;
  }) {
    return execute({
      runId: input.runId ?? randomUUID(),
      agent: {
        id: "agent-runner-outcome",
        companyId: "company-runner-outcome",
        name: "Contained Runner",
        adapterType: "process",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: process.execPath,
        args: [input.scriptPath],
        cwd: fixtureDir,
        timeoutSec: input.timeoutSec ?? 30,
        graceSec: input.graceSec ?? 5,
      },
      context: {},
      onLog: async () => {},
    });
  }

  it("treats a launcher-timed-out contained run as a timeout with resumable evidence", async () => {
    const runId = randomUUID();
    const script = await writeScript(
      "launcher-timeout.mjs",
      scriptSource(stdoutLine(launcherEnvelopeSource()), RUNNER_TIMEOUT_EXIT_CODE),
    );
    const result = await runProcessAdapter({ scriptPath: script, runId });

    // The launcher's reserved timeout code plus its validated envelope decide
    // the outcome; the persisted evidence keeps the checkpoint session.
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(RUNNER_TIMEOUT_EXIT_CODE);
    expect(result.errorCode).toBeUndefined();
    expect(result.errorMessage).toContain("wall-clock limit");
    expect(result.resultJson?.runnerTimeout).toEqual({
      sessionId: "paperclip-fc51e706-3ae84a40a9322b59f153",
      modelStarted: true,
      resumable: true,
      progress: { requests: 99, denials: 1, lastRequestAt: "2026-09-11T08:05:06.656Z" },
    });
  }, 30_000);

  it("keeps a native timeout unchanged", async () => {
    // Exercise the real subprocess kill path; fake timers cannot advance the child.
    const script = await writeScript("native-timeout.mjs", "setInterval(() => {}, 1000);\n");
    const result = await runProcessAdapter({ scriptPath: script, timeoutSec: 1, graceSec: 1 });

    // Native still kills the run on its own timer; without the launcher's
    // envelope no resumable evidence is attached.
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.resultJson?.runnerTimeout).toBeUndefined();
  }, 30_000);

  it("keeps a bare 124 an ordinary failure", async () => {
    const script = await writeScript(
      "bare-124.mjs",
      scriptSource("", RUNNER_TIMEOUT_EXIT_CODE),
    );
    const result = await runProcessAdapter({ scriptPath: script });

    // The reserved exit code alone is never a timeout: no envelope, no
    // resumability, and no continuation evidence.
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(RUNNER_TIMEOUT_EXIT_CODE);
    expect(result.errorCode).toBeUndefined();
    expect(result.errorMessage).toBe(`Process exited with code ${RUNNER_TIMEOUT_EXIT_CODE}`);
    expect(result.resultJson?.runnerTimeout).toBeUndefined();
    expect(result.resultJson?.runnerAdmissionRejection).toBeUndefined();
  }, 30_000);

  it("keeps malformed, foreign-run, and no-model timeout evidence ordinary failures", async () => {
    const runId = randomUUID();
    const cases: Array<[string, string]> = [
      ["malformed-124.mjs", scriptSource('process.stdout.write(\'{"kind":"run_timeout"\\n\');', RUNNER_TIMEOUT_EXIT_CODE)],
      ["foreign-run-124.mjs", scriptSource(stdoutLine(launcherEnvelopeSource({ runId: FOREIGN_RUN_ID })), RUNNER_TIMEOUT_EXIT_CODE)],
      ["no-model-124.mjs", scriptSource(stdoutLine(launcherEnvelopeSource({
        sessionId: null,
        modelStarted: false,
        resumable: false,
      })), RUNNER_TIMEOUT_EXIT_CODE)],
    ];
    for (const [name, source] of cases) {
      const scriptPath = await writeScript(name, source);
      const result = await runProcessAdapter({ scriptPath, runId });
      expect(result.timedOut, name).toBe(false);
      expect(result.errorCode, name).toBeUndefined();
      expect(result.errorMessage, name).toBe(`Process exited with code ${RUNNER_TIMEOUT_EXIT_CODE}`);
      expect(result.resultJson?.runnerTimeout, name).toBeUndefined();
    }
  }, 30_000);

  it("keeps timeout evidence on a non-timeout exit an ordinary failure", async () => {
    const runId = randomUUID();
    const script = await writeScript(
      "wrong-issuer.mjs",
      scriptSource(stdoutLine(launcherEnvelopeSource()), 1),
    );
    const result = await runProcessAdapter({ scriptPath: script, runId });

    // The envelope's issuer is the reserved exit code; a run that exits 1 while
    // printing a run_timeout record did not time out.
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBeUndefined();
    expect(result.errorMessage).toBe("Process exited with code 1");
    expect(result.resultJson?.runnerTimeout).toBeUndefined();
  }, 30_000);

  it("classifies a structured pre-model refusal reported with the generic failure exit", async () => {
    const runId = randomUUID();
    const script = await writeScript("refusal.mjs", scriptSource(stdoutLine(
      'JSON.stringify({ schemaVersion: 1, kind: "run_admission", status: "rejected", '
      + 'runId: process.env.PAPERCLIP_RUN_ID, issueId: "55ceb0cb-0000-4000-8000-000000000004", '
      + 'reasonCode: "recovery_incident_unadmitted", owner: "operator", '
      + 'nextAction: "Admit a recovery incident for this issue, then re-request the recovery run.", '
      + "modelStarted: false })",
    ), 1));
    const result = await runProcessAdapter({ scriptPath: script, runId });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("recovery_incident_unadmitted");
    expect(result.errorMessage).toBe("Run refused before model launch: recovery_incident_unadmitted");
    expect(result.resultJson?.runnerAdmissionRejection).toEqual({
      reasonCode: "recovery_incident_unadmitted",
      modelStarted: false,
      phase: null,
      nextAction: "Admit a recovery incident for this issue, then re-request the recovery run.",
      owner: "operator",
    });
  }, 30_000);

  it("keeps unproven exit-1 refusal envelopes ordinary failures", async () => {
    const runId = randomUUID();
    const refusalSource = (overrides: Record<string, unknown>) => stdoutLine(
      `JSON.stringify({ schemaVersion: 1, kind: "run_admission", status: "rejected", `
      + `runId: process.env.PAPERCLIP_RUN_ID, reasonCode: "recovery_incident_unadmitted", `
      + `owner: "operator", nextAction: "Admit a recovery incident for this issue.", `
      + `modelStarted: false, ...${JSON.stringify(overrides)} })`,
    );
    const cases: Array<[string, Record<string, unknown>]> = [
      // An unknown reason code is not a named producer refusal.
      ["refusal-unknown-reason.mjs", { reasonCode: "model_orchestrated_pause" }],
      // A refusal that claims a model started is not a pre-model refusal.
      ["refusal-model-started.mjs", { modelStarted: true }],
      // Another run's refusal record does not name this run.
      ["refusal-foreign-run.mjs", { runId: FOREIGN_RUN_ID }],
      // The envelope must not claim a reserved exit code the run did not exit with.
      ["refusal-reserved-claim.mjs", { exitCode: 96 }],
    ];
    for (const [name, overrides] of cases) {
      const scriptPath = await writeScript(name, scriptSource(refusalSource(overrides), 1));
      const result = await runProcessAdapter({ scriptPath, runId });
      expect(result.timedOut, name).toBe(false);
      expect(result.errorCode, name).toBeUndefined();
      expect(result.errorMessage, name).toBe("Process exited with code 1");
      expect(result.resultJson?.runnerAdmissionRejection, name).toBeUndefined();
    }
  }, 30_000);
});
