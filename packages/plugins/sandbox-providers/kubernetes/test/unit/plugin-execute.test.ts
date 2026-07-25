import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginEnvironmentExecuteParams } from "@paperclipai/plugin-sdk";

// Mock the kube-client module so onEnvironmentExecute runs against injected fake
// API clients instead of a real cluster, and stub execInPod so the command the
// plugin builds can be asserted without a pod. wrapCommandWithEnv is kept REAL:
// these tests are about the command the exec path actually sends.
const h = vi.hoisted(() => ({
  clients: {} as Record<string, unknown>,
  execInPod: vi.fn(),
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

vi.mock("../../src/pod-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/pod-exec.js")>()),
  execInPod: h.execInPod,
}));

import plugin from "../../src/plugin.js";

const CONFIG = { inCluster: true, backend: "sandbox-cr" };

// The plugin caches "already observed Ready" sandboxes per lease id for the
// worker's lifetime, so every call gets a fresh id to keep tests independent.
let leaseSeq = 0;

async function execute(overrides: Partial<PluginEnvironmentExecuteParams> = {}) {
  const providerLeaseId = `pc-exec-${++leaseSeq}`;
  return await plugin.definition.onEnvironmentExecute!({
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    config: CONFIG,
    lease: {
      providerLeaseId,
      metadata: {
        namespace: "paperclip-acme",
        jobName: providerLeaseId,
        podName: "pc-exec-pod",
        secretName: `${providerLeaseId}-env`,
        phase: "Running",
        backend: "sandbox-cr",
      },
    },
    // Not `sh -c <script>`: that shape is claimed by the fast-upload
    // interceptor, which is a different path from the one under test.
    command: "ls",
    args: ["-la"],
    ...overrides,
  });
}

/** The command array execInPod was called with (5th positional argument). */
function execCommand(): string[] {
  return h.execInPod.mock.calls[0]![4] as string[];
}

beforeEach(() => {
  h.clients = {
    custom: {
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { uid: "uid-1" },
        status: { phase: "Ready", podName: "pc-exec-pod" },
      }),
    },
  };
  h.execInPod.mockReset();
  h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
});

describe("onEnvironmentExecute cwd", () => {
  it("runs the command in params.cwd", async () => {
    await execute({ cwd: "/workspace/repo" });
    expect(execCommand()).toEqual([
      "/bin/sh",
      "-c",
      "cd '/workspace/repo' && exec 'ls' '-la'",
    ]);
  });

  it("changes directory before applying params.env", async () => {
    await execute({ cwd: "/workspace/repo", env: { FOO: "bar" } });
    expect(execCommand()[2]).toBe(
      "cd '/workspace/repo' && export FOO='bar'; exec 'ls' '-la'",
    );
  });

  it("leaves the command unwrapped when no cwd and no env are given", async () => {
    await execute();
    expect(execCommand()).toEqual(["ls", "-la"]);
  });
});

describe("onEnvironmentExecute signal", () => {
  // The Kubernetes exec API reports no termination signal, so the provider
  // reports the field explicitly as null rather than claiming an inferred one.
  it("reports the signal field explicitly on a clean exit", async () => {
    const result = await execute();
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
  });

  it("never claims a signal for a signal-shaped exit code it cannot observe", async () => {
    h.execInPod.mockResolvedValue({ exitCode: 137, stdout: "", stderr: "" });
    const result = await execute();
    expect(result.exitCode).toBe(137);
    expect(result.signal).toBeNull();
  });

  it("reports the signal field explicitly when the exec times out", async () => {
    h.execInPod.mockRejectedValue(new Error("execInPod timed out after 5000ms"));
    const result = await execute();
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
  });
});

describe("onEnvironmentExecute exit-status hints", () => {
  it("explains what exit code 137 usually means on Kubernetes", async () => {
    h.execInPod.mockResolvedValue({ exitCode: 137, stdout: "", stderr: "boom\n" });
    const result = await execute();
    expect(result.stderr).toContain("boom");
    expect(result.stderr).toContain("SIGKILL");
    expect(result.stderr).toContain("memory limit");
  });

  it("explains what exit code 143 usually means on Kubernetes", async () => {
    h.execInPod.mockResolvedValue({ exitCode: 143, stdout: "", stderr: "" });
    const result = await execute();
    expect(result.stderr).toContain("SIGTERM");
  });

  it("says the status is not proof of a termination", async () => {
    h.execInPod.mockResolvedValue({ exitCode: 137, stdout: "", stderr: "" });
    const result = await execute();
    expect(result.stderr).toMatch(/reports no signal/);
  });

  it("leaves stderr untouched for exits that carry no such meaning", async () => {
    h.execInPod.mockResolvedValue({ exitCode: 2, stdout: "", stderr: "usage: ls\n" });
    expect((await execute()).stderr).toBe("usage: ls\n");

    h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    expect((await execute()).stderr).toBe("");
  });
});
