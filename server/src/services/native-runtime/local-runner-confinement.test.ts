import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RUNNER_CONFINEMENT_UNAVAILABLE,
  localRunnerConfinementPolicy,
  resetLocalRunnerConfinementPaths,
  setLocalRunnerConfinementDatabase,
} from "./local-runner-confinement.js";
import { nativeSessionFailureDisposition, nativeSessionFailureSourceCode } from "./native-session-executor.js";
import { resetRunnerConfinementAvailability, setRunnerConfinementAvailabilityForTest, spawnRunner } from "../../vendor/paperclip-runner/testing.js";

describe("localRunnerConfinementPolicy", () => {
  afterEach(() => {
    setLocalRunnerConfinementDatabase(null);
    resetLocalRunnerConfinementPaths();
    vi.unstubAllEnvs();
  });

  it("confines local sessions by default to the instance, the company and away from the embedded database", () => {
    vi.stubEnv("PAPERCLIP_HOME", "/srv/paperclip-home");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("PAPERCLIP_LOCAL_AGENT_CONFINEMENT", "");
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", undefined);
    setLocalRunnerConfinementDatabase({ port: 54331, dataDir: "/srv/db" });
    const instanceRoot = resolve("/srv/paperclip-home", "instances", "default");
    expect(localRunnerConfinementPolicy("company-1")).toMatchObject({
      mode: "auto",
      instanceRoot,
      companyId: "company-1",
      sessionStateRoots: [resolve(instanceRoot, "runtime", "paperclip-runner", "durable-sessions")],
      privatePaths: expect.arrayContaining(["/srv/db"]),
      deniedLoopbackPorts: [54331],
    });
  });

  it("hides the operator's configured state, storage and secrets key locations", () => {
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", "/data/runner-state");
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", "/data/storage");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", "/keys/master.key");
    const policy = localRunnerConfinementPolicy("company-1");
    expect(policy.sessionStateRoots).toEqual(["/data/runner-state"]);
    expect(policy.privatePaths).toEqual(expect.arrayContaining(["/data/storage", "/keys/master.key"]));
  });

  it("follows the operator's confinement mode and an external database", () => {
    vi.stubEnv("PAPERCLIP_LOCAL_AGENT_CONFINEMENT", "required");
    expect(localRunnerConfinementPolicy("company-1")).toMatchObject({ mode: "required", deniedLoopbackPorts: [] });
  });
});

describe("a required confinement refusal", () => {
  afterEach(() => resetRunnerConfinementAvailability());

  /** The error a local OpenCode launch throws when confinement is required on a host that cannot provide it. */
  function requiredLaunchRefusal() {
    setRunnerConfinementAvailabilityForTest(process.platform, "confinement is not supported on this host");
    try {
      spawnRunner({
        connectUrl: "ws://127.0.0.1:9/unused",
        stateDirectory: "/nonexistent/runtime/paperclip-runner/durable-sessions/scope/runner",
        identity: { runnerInstanceId: "r", environmentLeaseId: "l", runId: "run", normalizedSessionId: "s", turnId: "t", itemId: "i" } as Parameters<typeof spawnRunner>[0]["identity"],
        ticket: "ticket",
        maxOutboxBytes: 1024,
        p0ReserveBytes: 128,
        runnerBinaryPath: "/nonexistent/paperclip-runnerd",
        runnerVersion: "test",
        runnerDigest: "test",
        opencodeLaunchProfile: {
          command: "/usr/bin/true", commandSha256: "0".repeat(64), proxyScript: "/dev/null", proxyScriptSha256: "0".repeat(64),
          executable: "/usr/bin/true", executableSha256: "0".repeat(64),
        },
        environment: {},
        confinement: { mode: "required", instanceRoot: "/nonexistent" },
      });
    } catch (error) {
      return error;
    }
    throw new Error("the launch did not refuse");
  }

  it("fails the run permanently by name instead of retrying, also when wrapped", () => {
    const refusal = requiredLaunchRefusal();
    for (const error of [refusal, new Error("runner startup failed", { cause: refusal })]) {
      const code = nativeSessionFailureSourceCode(error);
      expect(code).toBe(RUNNER_CONFINEMENT_UNAVAILABLE);
      expect(nativeSessionFailureDisposition(1, new Date(), code)).toEqual({
        phase: "terminal_failure",
        failureCode: RUNNER_CONFINEMENT_UNAVAILABLE,
        nextAttemptAt: null,
      });
    }
  });
});
