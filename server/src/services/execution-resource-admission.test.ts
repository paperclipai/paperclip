import { describe, expect, it } from "vitest";
import {
  EXECUTION_WRITER_RESOURCE_ACCESS,
  NATIVE_WRITER_ROOT_BUSY_REASON_CODE,
  RUNNER_RESOURCE_WAIT_EXIT_CODE,
  RUNNER_TIMEOUT_EXIT_CODE,
  parseExecutionWriterResourceReceipt,
  readExecutionResourceResolverConfig,
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
