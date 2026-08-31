import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "./execution-target.js";
import {
  buildDirectRunnerConnectUrl,
  resolvePaperclipRunnerTransport,
  type RunnerIngressEndpoint,
} from "./runner-connectivity.js";

const capabilities = {
  reusableLeases: false,
  nativeSyncIn: false,
  nativeSyncOut: false,
  persistentProcessSessions: true,
  independentControlCommands: true,
  incrementalSessionOutput: true,
  concurrentSyncOperations: false,
  duplexCommandStream: false,
  runnerWebSocketIngress: true,
} as const;

function ingress(): RunnerIngressEndpoint {
  const endpoint: RunnerIngressEndpoint = {
    kind: "authenticated_websocket",
    websocketUrl:
      "wss://43127-sandbox.proxy.daytona.test/api/runner/v1/connect/00000000-0000-4000-8000-000000000001",
    secretHeaders: [{ name: "X-Daytona-Preview-Token", value: "secret" }],
    generation: "generation-1",
    refresh: async () => endpoint,
    close: async () => undefined,
  };
  return endpoint;
}

describe("paperclip runner transport routing", () => {
  it("keeps same-host runnerd on plaintext loopback", async () => {
    const result = await resolvePaperclipRunnerTransport({
      target: { kind: "local" },
      runId: "00000000-0000-4000-8000-000000000001",
      localConnectUrl:
        "ws://127.0.0.1:3100/api/runner/v1/connect/00000000-0000-4000-8000-000000000001",
      enableRunnerPreviewIngress: false,
    });
    expect(result.mode).toBe("local_loopback");
  });

  it("selects provider ingress for Daytona-style capability even when a public URL exists", async () => {
    const getRunnerIngressEndpoint = vi.fn(async () => ingress());
    const target: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd: "/workspace",
      leaseId: "lease-1",
      effectiveCapabilities: capabilities,
      getRunnerIngressEndpoint,
    };
    const result = await resolvePaperclipRunnerTransport({
      target,
      runId: "00000000-0000-4000-8000-000000000001",
      localConnectUrl: "ws://127.0.0.1/unused",
      runnerPublicUrl: "wss://paperclip.example.test",
      enableRunnerPreviewIngress: true,
    });
    expect(result.mode).toBe("provider_ingress");
    expect(getRunnerIngressEndpoint).toHaveBeenCalledOnce();
  });

  it("does not request preview ingress while the new-runner rollout flag is off", async () => {
    const getRunnerIngressEndpoint = vi.fn(async () => ingress());
    const target: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd: "/workspace",
      leaseId: "lease-1",
      effectiveCapabilities: capabilities,
      getRunnerIngressEndpoint,
    };
    await expect(
      resolvePaperclipRunnerTransport({
        target,
        runId: "00000000-0000-4000-8000-000000000001",
        localConnectUrl: "ws://127.0.0.1/unused",
        runnerPublicUrl: "wss://paperclip.example.test",
        enableRunnerPreviewIngress: false,
      }),
    ).rejects.toMatchObject({ code: "runner_ingress_unavailable" });
    expect(getRunnerIngressEndpoint).not.toHaveBeenCalled();
  });

  it("selects direct WSS only for a remote target with an explicit URL", async () => {
    const target: AdapterExecutionTarget = {
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/workspace",
      spec: {
        host: "runner.internal",
        port: 22,
        username: "runner",
        remoteWorkspacePath: "/workspace",
        remoteCwd: "/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    const result = await resolvePaperclipRunnerTransport({
      target,
      runId: "00000000-0000-4000-8000-000000000001",
      localConnectUrl: "ws://127.0.0.1/unused",
      runnerPublicUrl: "wss://paperclip.example.test/runner-base/",
      runnerCaBundlePath: "/etc/paperclip/runner-ca.pem",
      enableRunnerPreviewIngress: false,
    });
    expect(result).toEqual({
      mode: "direct_outbound",
      connectUrl:
        "wss://paperclip.example.test/runner-base/api/runner/v1/connect/00000000-0000-4000-8000-000000000001",
      caBundlePath: "/etc/paperclip/runner-ca.pem",
    });
  });

  it("fails the selected ingress mode without falling through to direct WSS", async () => {
    const target: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd: "/workspace",
      leaseId: "lease-1",
      effectiveCapabilities: capabilities,
      getRunnerIngressEndpoint: async () => {
        throw new Error("preview unavailable");
      },
    };
    await expect(
      resolvePaperclipRunnerTransport({
        target,
        runId: "00000000-0000-4000-8000-000000000001",
        localConnectUrl: "ws://127.0.0.1/unused",
        runnerPublicUrl: "wss://paperclip.example.test",
        enableRunnerPreviewIngress: true,
      }),
    ).rejects.toThrow("preview unavailable");
  });

  it("never routes Daytona through direct outbound when ingress capability is unavailable", async () => {
    const target: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd: "/workspace",
      leaseId: "lease-1",
      effectiveCapabilities: {
        ...capabilities,
        runnerWebSocketIngress: false,
      },
    };
    await expect(
      resolvePaperclipRunnerTransport({
        target,
        runId: "00000000-0000-4000-8000-000000000001",
        localConnectUrl: "ws://127.0.0.1/unused",
        runnerPublicUrl: "wss://paperclip.example.test",
        enableRunnerPreviewIngress: true,
      }),
    ).rejects.toMatchObject({ code: "runner_ingress_unavailable" });
  });

  it.each([
    "ws://paperclip.example.test",
    "wss://user@paperclip.example.test",
    "wss://paperclip.example.test?token=secret",
    "wss://paperclip.example.test#fragment",
  ])("rejects unsafe direct runner URL %s", (runnerPublicUrl) => {
    expect(() =>
      buildDirectRunnerConnectUrl({
        runnerPublicUrl,
        runId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow();
  });
});
