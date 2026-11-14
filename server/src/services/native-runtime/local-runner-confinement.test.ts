import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RUNNER_CONFINEMENT_UNAVAILABLE,
  localRunnerConfinementPolicy,
  resetLocalRunnerConfinementPaths,
  setLocalRunnerConfinementDatabase,
} from "./local-runner-confinement.js";
import { nativeSessionFailureDisposition, nativeSessionFailureSourceCode } from "./native-session-executor.js";

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
  it("fails the run permanently by name instead of retrying", () => {
    const error = new Error(`${RUNNER_CONFINEMENT_UNAVAILABLE}: confinement is not supported on win32`);
    const code = nativeSessionFailureSourceCode(error);
    expect(code).toBe(RUNNER_CONFINEMENT_UNAVAILABLE);
    expect(nativeSessionFailureDisposition(1, new Date(), code)).toEqual({
      phase: "terminal_failure",
      failureCode: RUNNER_CONFINEMENT_UNAVAILABLE,
      nextAttemptAt: null,
    });
  });
});
