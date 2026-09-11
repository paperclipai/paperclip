import { describe, expect, it } from "vitest";
import {
  EXECUTION_WRITER_RESOURCE_ACCESS,
  NATIVE_WRITER_ROOT_BUSY_REASON_CODE,
  RUNNER_RESOURCE_WAIT_EXIT_CODE,
  RUNNER_TIMEOUT_EXIT_CODE,
  parseExecutionWriterResourceReceipt,
  readExecutionResourceResolverConfig,
  readRunnerAdmissionRejection,
  readRunnerResourceWait,
  readRunnerTimeoutEvidence,
} from "./execution-resource-admission.js";

const RUN_ID = "5f0a1d2c-0000-4000-8000-000000000001";

function envelopeLine(record: Record<string, unknown>) {
  return JSON.stringify(record);
}

function resourceWaitEnvelope(overrides: Record<string, unknown> = {}) {
  return envelopeLine({
    schemaVersion: 1,
    kind: "run_admission",
    status: "deferred",
    runId: RUN_ID,
    reasonCode: "writer_root_busy",
    detail: "another container still owns this writer root",
    owner: "technical-recovery",
    nextAction: "Re-admit after the writer root is free.",
    retryCondition: "after the canonical writer root is released",
    containerName: "paperclip-worker-abc",
    modelStarted: false,
    exitCode: RUNNER_RESOURCE_WAIT_EXIT_CODE,
    ...overrides,
  });
}

describe("readRunnerResourceWait", () => {
  it("classifies a refused run reported with the reserved code and its envelope", () => {
    expect(
      readRunnerResourceWait({
        exitCode: RUNNER_RESOURCE_WAIT_EXIT_CODE,
        stdout: `worker chatter\n${resourceWaitEnvelope()}\n`,
        runId: RUN_ID,
      }),
    ).toEqual({
      reasonCode: "writer_root_busy",
      detail: "another container still owns this writer root",
      owner: "technical-recovery",
      nextAction: "Re-admit after the writer root is free.",
      retryCondition: "after the canonical writer root is released",
      containerName: "paperclip-worker-abc",
    });
  });

  it("never invents a deferral from an exit code alone", () => {
    expect(
      readRunnerResourceWait({ exitCode: RUNNER_RESOURCE_WAIT_EXIT_CODE, stdout: "no envelope", runId: RUN_ID }),
    ).toBeNull();
    // A generic containment failure that happens to exit 5 stays a failure.
    expect(
      readRunnerResourceWait({ exitCode: 5, stdout: resourceWaitEnvelope(), runId: RUN_ID }),
    ).toBeNull();
  });

  it("rejects a forged or unrelated envelope", () => {
    // Another run's envelope cannot defer this run.
    expect(
      readRunnerResourceWait({
        exitCode: RUNNER_RESOURCE_WAIT_EXIT_CODE,
        stdout: resourceWaitEnvelope({ runId: "11111111-1111-4111-8111-111111111111" }),
        runId: RUN_ID,
      }),
    ).toBeNull();
    // A refusal that claims a model started is not a refusal.
    expect(
      readRunnerResourceWait({
        exitCode: RUNNER_RESOURCE_WAIT_EXIT_CODE,
        stdout: resourceWaitEnvelope({ modelStarted: true }),
        runId: RUN_ID,
      }),
    ).toBeNull();
    // Unknown reasons are not deferrable.
    expect(
      readRunnerResourceWait({
        exitCode: RUNNER_RESOURCE_WAIT_EXIT_CODE,
        stdout: resourceWaitEnvelope({ reasonCode: "model_orchestrated_pause" }),
        runId: RUN_ID,
      }),
    ).toBeNull();
    // A rejection record is not a deferral.
    expect(
      readRunnerResourceWait({
        exitCode: RUNNER_RESOURCE_WAIT_EXIT_CODE,
        stdout: resourceWaitEnvelope({ status: "rejected" }),
        runId: RUN_ID,
      }),
    ).toBeNull();
  });

  it("classifies the supervisor canonical lease conflict", () => {
    expect(
      readRunnerResourceWait({
        exitCode: RUNNER_RESOURCE_WAIT_EXIT_CODE,
        stdout: resourceWaitEnvelope({ reasonCode: "canonical_target_conflict" }),
        runId: RUN_ID,
      })?.reasonCode,
    ).toBe("canonical_target_conflict");
  });

  it("keeps the native writer-root reason distinct from the runner reasons", () => {
    expect(NATIVE_WRITER_ROOT_BUSY_REASON_CODE).toBe("canonical_writer_root_busy");
    expect(
      readRunnerResourceWait({
        exitCode: RUNNER_RESOURCE_WAIT_EXIT_CODE,
        stdout: resourceWaitEnvelope({ reasonCode: NATIVE_WRITER_ROOT_BUSY_REASON_CODE }),
        runId: RUN_ID,
      }),
    ).toBeNull();
  });
});

describe("readRunnerAdmissionRejection", () => {
  const refusal = (overrides: Record<string, unknown> = {}) => envelopeLine({
    schemaVersion: 1,
    kind: "run_admission",
    status: "rejected",
    runId: RUN_ID,
    exitCode: 96,
    reasonCode: "image_prerequisite_missing",
    modelStarted: false,
    phase: "image",
    ...overrides,
  });

  // The launcher's exit-1 refusal shape (rejectRunAdmission): no exitCode and
  // no phase on the envelope, the reason code names the refusal.
  const genericRefusal = (overrides: Record<string, unknown> = {}) => envelopeLine({
    schemaVersion: 1,
    kind: "run_admission",
    status: "rejected",
    runId: RUN_ID,
    reasonCode: "recovery_incident_unadmitted",
    owner: "operator",
    nextAction: "Admit a recovery incident for this issue, then re-request the recovery run.",
    modelStarted: false,
    ...overrides,
  });

  it("retains a run-bound prerequisite failure without turning it into contention", () => {
    const input = { exitCode: 96, stdout: refusal(), runId: RUN_ID };
    expect(readRunnerAdmissionRejection(input)).toMatchObject({
      reasonCode: "image_prerequisite_missing", modelStarted: false, phase: "image",
    });
    expect(readRunnerResourceWait(input)).toBeNull();
  });

  it("classifies a structured pre-model refusal reported with the generic failure exit", () => {
    const input = { exitCode: 1, stdout: genericRefusal(), runId: RUN_ID };
    expect(readRunnerAdmissionRejection(input)).toEqual({
      reasonCode: "recovery_incident_unadmitted",
      modelStarted: false,
      phase: null,
      nextAction: "Admit a recovery incident for this issue, then re-request the recovery run.",
      owner: "operator",
    });
    // A refusal is failure evidence, never a resource wait.
    expect(readRunnerResourceWait(input)).toBeNull();
  });

  it("leaves unproven, foreign, or inconsistent exit-1 refusals as ordinary failures", () => {
    for (const stdout of [
      "generic process failure",
      genericRefusal({ runId: "11111111-1111-4111-8111-111111111111" }),
      genericRefusal({ modelStarted: true }),
      genericRefusal({ status: "deferred" }),
      // An unknown reason code is not a named producer refusal.
      genericRefusal({ reasonCode: "model_orchestrated_pause" }),
      // The envelope must not claim a reserved exit code the run did not exit with.
      genericRefusal({ exitCode: 96 }),
      genericRefusal({ schemaVersion: 2 }),
    ]) {
      expect(readRunnerAdmissionRejection({ exitCode: 1, stdout, runId: RUN_ID })).toBeNull();
    }
    // A reserved refusal envelope is not an exit-1 refusal either.
    expect(readRunnerAdmissionRejection({ exitCode: 1, stdout: refusal(), runId: RUN_ID })).toBeNull();
  });

  it("leaves unproven, foreign, or inconsistent refusals as ordinary failures", () => {
    for (const stdout of [
      "generic process failure",
      refusal({ runId: "another-run" }),
      refusal({ modelStarted: true }),
      refusal({ status: "deferred" }),
      refusal({ exitCode: 97 }),
      refusal({ reasonCode: "broker_unavailable" }),
      refusal({ schemaVersion: 2 }),
    ]) {
      expect(readRunnerAdmissionRejection({ exitCode: 96, stdout, runId: RUN_ID })).toBeNull();
    }
    expect(readRunnerAdmissionRejection({
      exitCode: 5, stdout: refusal(), runId: RUN_ID,
    })).toBeNull();
  });
});

describe("readRunnerTimeoutEvidence", () => {
  const timeoutEnvelope = (overrides: Record<string, unknown> = {}) =>
    envelopeLine({
      schemaVersion: 1,
      kind: "run_timeout",
      status: "timed_out",
      runId: RUN_ID,
      sessionId: "paperclip-issue-lane",
      modelStarted: true,
      resumable: true,
      progress: { requests: 7, denials: 1, lastRequestAt: "2026-09-10T00:00:00.000Z" },
      exitCode: RUNNER_TIMEOUT_EXIT_CODE,
      ...overrides,
    });

  it("reads the resume identity and bounded progress of a timed-out run", () => {
    expect(
      readRunnerTimeoutEvidence({
        exitCode: RUNNER_TIMEOUT_EXIT_CODE,
        stdout: timeoutEnvelope(),
        runId: RUN_ID,
      }),
    ).toEqual({
      sessionId: "paperclip-issue-lane",
      modelStarted: true,
      resumable: true,
      progress: { requests: 7, denials: 1, lastRequestAt: "2026-09-10T00:00:00.000Z" },
    });
  });

  it("ignores a run that never reached the model", () => {
    expect(
      readRunnerTimeoutEvidence({
        exitCode: RUNNER_TIMEOUT_EXIT_CODE,
        stdout: timeoutEnvelope({ modelStarted: false }),
        runId: RUN_ID,
      }),
    ).toBeNull();
    expect(
      readRunnerTimeoutEvidence({
        exitCode: RUNNER_TIMEOUT_EXIT_CODE,
        stdout: timeoutEnvelope(),
        runId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toBeNull();
  });

  it("rejects an outcome that contradicts the launcher timeout exit", () => {
    for (const overrides of [{ status: "succeeded" }, { exitCode: 1 }]) {
      expect(readRunnerTimeoutEvidence({
        exitCode: RUNNER_TIMEOUT_EXIT_CODE,
        stdout: timeoutEnvelope(overrides),
        runId: RUN_ID,
      })).toBeNull();
    }
  });

  it("reads the launcher's own timeout envelope shape unchanged", () => {
    // Exact producer shape (paperclip.mjs run-outcome record): issueId, role,
    // status, and a progress timestamp named lastEventAt.
    const producerEnvelope = envelopeLine({
      schemaVersion: 1,
      kind: "run_timeout",
      status: "timed_out",
      runId: RUN_ID,
      issueId: "3a4c9d1e-0000-4000-8000-000000000002",
      sessionId: "paperclip-issue-lane",
      modelStarted: true,
      resumable: true,
      progress: { requests: 99, denials: 1, lastEventAt: "2026-09-11T08:05:06.656Z" },
      exitCode: RUNNER_TIMEOUT_EXIT_CODE,
    });
    expect(
      readRunnerTimeoutEvidence({
        exitCode: RUNNER_TIMEOUT_EXIT_CODE,
        stdout: `worker chatter\n${producerEnvelope}\n`,
        runId: RUN_ID,
      }),
    ).toEqual({
      sessionId: "paperclip-issue-lane",
      modelStarted: true,
      resumable: true,
      progress: { requests: 99, denials: 1, lastRequestAt: "2026-09-11T08:05:06.656Z" },
    });
    // The reserved code alone is never evidence.
    expect(
      readRunnerTimeoutEvidence({ exitCode: RUNNER_TIMEOUT_EXIT_CODE, stdout: "no envelope", runId: RUN_ID }),
    ).toBeNull();
    // The envelope on a different exit code is not timeout evidence.
    expect(
      readRunnerTimeoutEvidence({ exitCode: 1, stdout: producerEnvelope, runId: RUN_ID }),
    ).toBeNull();
  });
});

describe("readExecutionResourceResolverConfig", () => {
  it("treats an absent resolver as not opted in", () => {
    expect(readExecutionResourceResolverConfig(null)).toBeNull();
    expect(readExecutionResourceResolverConfig(undefined)).toBeNull();
  });

  it("requires absolute operator-provisioned paths", () => {
    expect(
      readExecutionResourceResolverConfig({
        command: "/usr/local/bin/node",
        entry: "/opt/paperclip/src/runtime/paperclip.mjs",
        template: "/opt/paperclip/launch.json",
      }),
    ).toEqual({
      command: "/usr/local/bin/node",
      entry: "/opt/paperclip/src/runtime/paperclip.mjs",
      template: "/opt/paperclip/launch.json",
      timeoutMs: 15_000,
    });
    expect(() =>
      readExecutionResourceResolverConfig({
        command: "node",
        entry: "/opt/paperclip/src/runtime/paperclip.mjs",
        template: "/opt/paperclip/launch.json",
      }),
    ).toThrow(/absolute/);
    expect(() =>
      readExecutionResourceResolverConfig({ command: "/usr/local/bin/node" }),
    ).toThrow(/absolute/);
  });

  it("bounds the resolver timeout", () => {
    expect(
      readExecutionResourceResolverConfig({
        command: "/usr/local/bin/node",
        entry: "/opt/paperclip/src/runtime/paperclip.mjs",
        template: "/opt/paperclip/launch.json",
        timeoutMs: 2_000,
      })?.timeoutMs,
    ).toBe(2_000);
    expect(() =>
      readExecutionResourceResolverConfig({
        command: "/usr/local/bin/node",
        entry: "/opt/paperclip/src/runtime/paperclip.mjs",
        template: "/opt/paperclip/launch.json",
        timeoutMs: 600_000,
      }),
    ).toThrow(/timeoutMs/);
  });
});

describe("parseExecutionWriterResourceReceipt", () => {
  const identity = `writer-config-v1:${"a".repeat(64)}`;
  const rootKey = `writer-root-v1:${"b".repeat(64)}`;

  it("accepts the three admitted accesses with their matching writer identity", () => {
    expect(
      parseExecutionWriterResourceReceipt(
        envelopeLine({ schemaVersion: 1, kind: "paperclip_execution_writer_resource", access: "isolated", writerRootKey: null, configIdentity: identity }),
      ),
    ).toEqual({ access: "isolated", writerRootKey: null, configIdentity: identity });
    // Both non-isolated accesses name the canonical physical lane they touch, so
    // native can serialize read/write overlap before dispatch.
    expect(
      parseExecutionWriterResourceReceipt(
        envelopeLine({ schemaVersion: 1, kind: "paperclip_execution_writer_resource", access: "read_only", writerRootKey: rootKey, configIdentity: identity }),
      ),
    ).toEqual({ access: "read_only", writerRootKey: rootKey, configIdentity: identity });
    expect(
      parseExecutionWriterResourceReceipt(
        envelopeLine({ schemaVersion: 1, kind: "paperclip_execution_writer_resource", access: "exclusive", writerRootKey: rootKey, configIdentity: identity }),
      ),
    ).toEqual({ access: "exclusive", writerRootKey: rootKey, configIdentity: identity });
    expect(EXECUTION_WRITER_RESOURCE_ACCESS.exclusive).toBe("exclusive");
  });

  it("refuses a receipt whose access and identity contradict each other", () => {
    const base = { schemaVersion: 1, kind: "paperclip_execution_writer_resource", configIdentity: identity };
    // A writer admission without an identifiable lane can never be reserved.
    expect(parseExecutionWriterResourceReceipt(envelopeLine({ ...base, access: "read_only", writerRootKey: null }))).toBeNull();
    expect(parseExecutionWriterResourceReceipt(envelopeLine({ ...base, access: "read_only" }))).toBeNull();
    expect(parseExecutionWriterResourceReceipt(envelopeLine({ ...base, access: "exclusive", writerRootKey: null }))).toBeNull();
    // An isolated run cannot claim a canonical lane.
    expect(parseExecutionWriterResourceReceipt(envelopeLine({ ...base, access: "isolated", writerRootKey: rootKey }))).toBeNull();
    expect(parseExecutionWriterResourceReceipt(envelopeLine({ ...base, access: "exclusive", writerRootKey: "writer-root-v1:short" }))).toBeNull();
    expect(parseExecutionWriterResourceReceipt(envelopeLine({ ...base, access: "exclusive", writerRootKey: rootKey, configIdentity: "writer-config-v1:nope" }))).toBeNull();
    expect(parseExecutionWriterResourceReceipt(envelopeLine({ ...base, access: "write_everything", writerRootKey: rootKey }))).toBeNull();
    expect(parseExecutionWriterResourceReceipt("no receipt here")).toBeNull();
  });
});
