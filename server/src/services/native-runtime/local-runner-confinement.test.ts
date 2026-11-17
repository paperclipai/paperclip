import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RUNNER_CONFINEMENT_UNAVAILABLE,
  localRunnerConfinementPolicy,
  resetLocalRunnerConfinementPaths,
  serverInstallationRoot,
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
    vi.stubEnv("PAPERCLIP_CONFIG", "/etc/paperclip/config.json");
    const policy = localRunnerConfinementPolicy("company-1");
    expect(policy.sessionStateRoots).toEqual(["/data/runner-state"]);
    expect(policy.privatePaths).toEqual(expect.arrayContaining(["/data/storage", "/keys/master.key", "/etc/paperclip/config.json", "/etc/paperclip/.env"]));
  });

  it("follows the operator's confinement mode and an external database", () => {
    vi.stubEnv("PAPERCLIP_LOCAL_AGENT_CONFINEMENT", "required");
    expect(localRunnerConfinementPolicy("company-1")).toMatchObject({ mode: "required", deniedLoopbackPorts: [] });
  });
});

describe("serverInstallationRoot", () => {
  it("freezes an installed server package but not a source checkout, the home directory or the root", () => {
    expect(serverInstallationRoot("/usr/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/index.js", "/home/u"))
      .toBe("/usr/lib/node_modules/paperclipai");
    expect(serverInstallationRoot("/opt/x/node_modules/@paperclipai/server/dist/index.js", "/home/u")).toBe("/opt/x/node_modules/@paperclipai/server");
    expect(serverInstallationRoot("/home/u/node_modules/paperclipai/dist/index.js", "/home/u")).toBe("/home/u/node_modules/paperclipai");
    // Outside any Git checkout, so only the fixtures' own .git counts.
    const base = mkdtempSync(join(tmpdir(), "server-install-test-"));
    try {
      // An image layout: /app/node_modules beside /app/server.
      mkdirSync(join(base, "app", "node_modules"), { recursive: true });
      mkdirSync(join(base, "app", "server", "dist-runtime"), { recursive: true });
      expect(serverInstallationRoot(join(base, "app", "server", "dist-runtime", "index.mjs"), "/home/u")).toBe(join(base, "app"));
      // A source checkout stays writable.
      mkdirSync(join(base, "app", ".git"));
      expect(serverInstallationRoot(join(base, "app", "server", "dist-runtime", "index.mjs"), "/home/u")).toBeNull();
      rmSync(join(base, "app", ".git"), { recursive: true });
      // The pnpm monorepo: server/node_modules beside the server, .git at the repository root.
      mkdirSync(join(base, "repo", "server", "node_modules"), { recursive: true });
      mkdirSync(join(base, "repo", "server", "dist"), { recursive: true });
      mkdirSync(join(base, "repo", ".git"));
      expect(serverInstallationRoot(join(base, "repo", "server", "dist", "index.js"), "/home/u")).toBeNull();
      // An install inside another project's checkout is still an install.
      mkdirSync(join(base, "project", ".git"), { recursive: true });
      expect(serverInstallationRoot(join(base, "project", "node_modules", "paperclipai", "dist", "index.js"), "/home/u"))
        .toBe(join(base, "project", "node_modules", "paperclipai"));
      // Never the home directory.
      expect(serverInstallationRoot(join(base, "app", "server", "dist-runtime", "index.mjs"), join(base, "app"))).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
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
