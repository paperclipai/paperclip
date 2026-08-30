import { describe, expect, it } from "vitest";

import {
  buildNativeRunnerArguments,
  buildNativeRunnerEnvironment,
  nativeCodexRunnerRemoteInternals,
  queueNativeRunnerTermination,
  requestRemoteNativeRunnerCancellation,
  resolveRemoteNativeRunnerConfig,
} from "./native-codex-runner.js";

describe("buildNativeRunnerArguments", () => {
  it("binds every durable identity without exposing the bootstrap ticket", () => {
    const args = buildNativeRunnerArguments({
      connectUrl: "ws://127.0.0.1:3000/api/runner/v1/connect/run-1",
      stateDirectory: "/tmp/runner-state",
      runnerInstanceId: "runner-1",
      environmentLeaseId: "lease-1",
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
      runnerDigest: `sha256:${"a".repeat(64)}`,
      maxRuntimeMs: 60_000,
    });
    expect(args).toContain("--connect-url");
    expect(args).toContain("--runner-digest");
    expect(args.join(" ")).not.toContain("bootstrap");
  });

  it("binds a remote host without placing the bootstrap ticket in argv", () => {
    const args = buildNativeRunnerArguments({
      connectUrl: "ws://paperclip.internal:3100/api/runner/v1/connect/run-1",
      stateDirectory: "/runner-runtime/runner/run-1",
      runnerInstanceId: "runner-1",
      environmentLeaseId: "lease-1",
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
      runnerDigest: `sha256:${"b".repeat(64)}`,
      maxRuntimeMs: 60_000,
      allowRemoteHost: "paperclip.internal",
    });
    expect(args).toContain("--allow-remote-host");
    expect(args).toContain("paperclip.internal");
    expect(args.join(" ")).not.toContain("bootstrap");
  });
});

describe("resolveRemoteNativeRunnerConfig", () => {
  it("requires an immutable runner digest and an absolute remote runtime root", () => {
    expect(resolveRemoteNativeRunnerConfig({
      PAPERCLIP_RUNNER_REMOTE_DIGEST: `sha256:${"c".repeat(64)}`,
      PAPERCLIP_RUNNER_REMOTE_RUNTIME_ROOT: "/runner-runtime",
      PAPERCLIP_RUNNER_REMOTE_BINARY: "/opt/paperclip/bin/paperclip-runnerd",
    })).toEqual({
      binary: "/opt/paperclip/bin/paperclip-runnerd",
      digest: `sha256:${"c".repeat(64)}`,
      runtimeRoot: "/runner-runtime",
      codexHome: null,
    });
    expect(() => resolveRemoteNativeRunnerConfig({
      PAPERCLIP_RUNNER_REMOTE_DIGEST: "latest",
    })).toThrow(/must be a sha256 digest/);
    expect(() => resolveRemoteNativeRunnerConfig({
      PAPERCLIP_RUNNER_REMOTE_DIGEST: `sha256:${"c".repeat(64)}`,
      PAPERCLIP_RUNNER_REMOTE_BINARY: "/opt/paperclip/bin/paperclip-runnerd",
      PAPERCLIP_RUNNER_REMOTE_RUNTIME_ROOT: "runner-runtime",
    })).toThrow(/absolute POSIX path/);
    expect(() => resolveRemoteNativeRunnerConfig({
      PAPERCLIP_RUNNER_REMOTE_DIGEST: `sha256:${"c".repeat(64)}`,
      PAPERCLIP_RUNNER_REMOTE_BINARY: "paperclip-runnerd",
    })).toThrow(/REMOTE_BINARY.*absolute POSIX path/);
  });

  it("accepts an optional pre-provisioned remote Codex home", () => {
    expect(resolveRemoteNativeRunnerConfig({
      PAPERCLIP_RUNNER_REMOTE_DIGEST: `sha256:${"d".repeat(64)}`,
      PAPERCLIP_RUNNER_REMOTE_BINARY: "/opt/paperclip/bin/paperclip-runnerd",
      PAPERCLIP_RUNNER_REMOTE_CODEX_HOME: "/opt/paperclip/codex-home",
    }).codexHome).toBe("/opt/paperclip/codex-home");
    expect(() => resolveRemoteNativeRunnerConfig({
      PAPERCLIP_RUNNER_REMOTE_DIGEST: `sha256:${"d".repeat(64)}`,
      PAPERCLIP_RUNNER_REMOTE_BINARY: "/opt/paperclip/bin/paperclip-runnerd",
      PAPERCLIP_RUNNER_REMOTE_CODEX_HOME: "relative/codex-home",
    })).toThrow(/REMOTE_CODEX_HOME.*absolute POSIX path/);
  });
});

describe("buildNativeRunnerEnvironment", () => {
  it("does not inherit control-plane secrets for a remote launch", () => {
    expect(buildNativeRunnerEnvironment({
      runtimeEnvironment: { GH_TOKEN: "short-lived" },
      codexHome: "/runner-runtime/codex/run-1",
      bootstrapTicket: "one-use-ticket",
    })).toEqual({
      GH_TOKEN: "short-lived",
      CODEX_HOME: "/runner-runtime/codex/run-1",
      PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: "one-use-ticket",
    });
    expect(buildNativeRunnerEnvironment({
      runtimeEnvironment: {},
      codexHome: "/runner-runtime/codex/run-1",
      bootstrapTicket: "one-use-ticket",
      hostEnvironment: { DATABASE_URL: "must-stay-local" },
    })).toMatchObject({ DATABASE_URL: "must-stay-local" });
  });
});

describe("remote native runner preparation", () => {
  it("copies verified bytes into a private run path and verifies that copy", () => {
    const script = nativeCodexRunnerRemoteInternals.buildRemoteRunnerInstallScript({
      sourceBinary: "/opt/paperclip/bin/paperclip-runnerd",
      digest: `sha256:${"e".repeat(64)}`,
      runtimeRoot: "/runner-runtime",
      runRoot: "/runner-runtime/runs/abc",
      stateDirectory: "/runner-runtime/runs/abc/state",
      verifiedBinary: "/runner-runtime/runs/abc/bin/paperclip-runnerd",
    });
    expect(script).toContain("cp -- /proc/self/fd/9");
    expect(script).toContain("chmod 500");
    expect(script).toContain("chmod 700 '/runner-runtime/runs/abc'");
    expect(script.match(/paperclip_runner_expected_sha=/g)).toHaveLength(2);
    expect(script).not.toContain("bootstrap");
  });

  it("stages Codex seeds through stdin into an atomic private home and removes the run root", () => {
    const prepareScript = nativeCodexRunnerRemoteInternals.buildPrivateRemoteCodexHomeScript({
      runRoot: "/runner-runtime/runs/abc",
      codexHome: "/runner-runtime/runs/abc/codex-home",
      sourceCodexHome: null,
    });
    const cleanupScript = nativeCodexRunnerRemoteInternals.buildRemoteRuntimeCleanupScript(
      "/runner-runtime/runs/abc",
    );
    expect(prepareScript).toContain("IFS= read -r paperclip_codex_auth");
    expect(prepareScript).toContain("chmod 600");
    expect(prepareScript).toContain("chmod 700 '/runner-runtime/runs/abc/codex-home'");
    expect(prepareScript).toContain("codex-home.prepare");
    expect(prepareScript).not.toContain("auth-secret");
    expect(cleanupScript).toContain("rm -rf -- '/runner-runtime/runs/abc'");
  });

  it("never exports an agent-selected local Codex home to a remote target", () => {
    const resolveSeedHome = nativeCodexRunnerRemoteInternals.resolveNativeCodexSeedHome;
    expect(resolveSeedHome({
      remote: true,
      runtimeEnvironment: { CODEX_HOME: "C:/sensitive/agent-selected" },
      hostEnvironment: { CODEX_HOME: "C:/trusted/operator-home" },
    })).toBe("C:/trusted/operator-home");
    expect(resolveSeedHome({
      remote: true,
      runtimeEnvironment: { CODEX_HOME: "C:/sensitive/agent-selected" },
      hostEnvironment: {},
    })).toBeNull();
    expect(resolveSeedHome({
      remote: false,
      runtimeEnvironment: { CODEX_HOME: "C:/local-agent-home" },
      hostEnvironment: { CODEX_HOME: "C:/trusted/operator-home" },
    })).toBe("C:/local-agent-home");
  });
});

describe("remote native runner cancellation", () => {
  it("queues a bound cancellation and orderly runner shutdown", () => {
    const queued: Array<{ type: string; payload: Record<string, unknown>; commandId?: string }> = [];
    queueNativeRunnerTermination({
      prepared: {
        queueCommand(type, payload = {}, commandId) {
          queued.push({ type, payload, commandId });
          return { commandId: commandId ?? "generated", controllerSeq: queued.length };
        },
      },
      runId: "run-1",
      cancel: true,
      reason: "Cancelled by control plane",
    });

    expect(queued).toEqual([
      {
        type: "run.cancel",
        payload: { reason: "Cancelled by control plane" },
        commandId: "cancel_run-1",
      },
      { type: "session.close", payload: {}, commandId: "close_run-1" },
      { type: "runner.shutdown", payload: {}, commandId: "shutdown_run-1" },
    ]);
  });

  it("does not claim an inactive remote run", () => {
    expect(requestRemoteNativeRunnerCancellation("inactive-run", "cancel")).toBe(false);
  });
});
