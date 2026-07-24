import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the kube-client module so the plugin handler runs against injected
// fake API clients instead of a real cluster, mirroring the pattern in
// plugin-lease-lifecycle.test.ts.
const h = vi.hoisted(() => ({ clients: {} as Record<string, unknown> }));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

vi.mock("../../src/tenant-orchestrator.js", () => ({
  ensureTenant: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/secret-manager.js", () => ({
  createPerRunSecret: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/sandbox-cr-orchestrator.js", () => ({
  sandboxCrOrchestrator: {
    claim: vi.fn().mockResolvedValue({ uid: "owner-uid-1" }),
    findPod: vi.fn().mockResolvedValue("pc-abc-pod"),
  },
  SandboxCrTimeoutError: class SandboxCrTimeoutError extends Error {},
}));

vi.mock("../../src/job-orchestrator.js", () => ({
  jobOrchestrator: {
    claim: vi.fn().mockResolvedValue({ uid: "owner-uid-1" }),
    findPod: vi.fn().mockResolvedValue("pc-abc-pod"),
  },
  JobTimeoutError: class JobTimeoutError extends Error {},
}));

import plugin from "../../src/plugin.js";

const CONFIG = { inCluster: true, backend: "sandbox-cr" };

beforeEach(() => {
  h.clients = {};
});

describe("onEnvironmentAcquireLease lease metadata", () => {
  // Gap-1 (second layer): the server's reusable-lease scope is built from
  // whatever adapterType/image it can see at publish time. If the plugin
  // resolves a per-run adapter (or falls back to the environment default)
  // but never surfaces that resolution in the lease metadata, the server has
  // no positive signal to persist and the scope ends up null, exactly the
  // "matched by any run" gap the strict null-never-matches rule in
  // environment-runtime.ts guards against. Persisting them here means the
  // scope is populated even when the server's own per-run hint is absent.
  it("persists the resolved adapter type and runtime image when adapterType is supplied", async () => {
    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      runId: "run-1",
      adapterType: "claude_local",
    });

    expect(lease.providerLeaseId).toEqual(expect.any(String));
    expect(lease.metadata).toEqual(
      expect.objectContaining({
        adapterType: "claude_local",
        image: "ghcr.io/paperclipai/agent-runtime-claude:v1",
      }),
    );
  });

  it("persists the environment-configured default adapter type when no per-run adapterType is supplied", async () => {
    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: {
        ...CONFIG,
        adapterType: "codex_local",
        // The env-default fallback is only safe when the config POSITIVELY
        // proves a single-adapter environment (see #9950's
        // resolveRunAdapterType); otherwise an adapter-less run is rejected
        // rather than falling back. A configured `adapters` registry is
        // authoritative (replace semantics), so it must be complete.
        adapters: [{
          adapterType: "codex_local",
          enabled: true,
          runtimeImage: "ghcr.io/paperclipai/agent-runtime-codex:v1",
        }],
      },
      runId: "run-2",
    });

    expect(lease.metadata).toEqual(
      expect.objectContaining({
        adapterType: "codex_local",
        image: "ghcr.io/paperclipai/agent-runtime-codex:v1",
      }),
    );
  });
});
