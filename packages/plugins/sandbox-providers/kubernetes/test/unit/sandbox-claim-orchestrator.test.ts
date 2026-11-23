import { describe, it, expect, vi } from "vitest";
import {
  buildSandboxClaimManifest,
  buildSandboxTemplateManifest,
  buildSandboxWarmPoolManifest,
  createSandboxClaim,
  deleteSandboxClaim,
  SANDBOX_EXTENSIONS_API_VERSION,
  SandboxClaimTimeoutError,
  waitForSandboxClaimReady,
} from "../../src/sandbox-claim-orchestrator.js";

describe("v1beta1 SandboxClaim / SandboxTemplate / SandboxWarmPool builders", () => {
  it("builds a v1beta1 SandboxClaim with mandatory TTL shutdownTime and DeleteForeground", () => {
    const nowMs = Date.parse("2026-11-23T00:00:00.000Z");
    const manifest = buildSandboxClaimManifest({
      namespace: "paperclip-acme",
      claimName: "claim-01",
      templateName: "agent-runtime-claude-warm",
      runId: "run-01",
      companyId: "comp-01",
      ttlSeconds: 1800,
      nowMs,
    }) as {
      apiVersion: string;
      kind: string;
      metadata: { labels: Record<string, string> };
      spec: {
        sandboxTemplateRef: { name: string };
        lifecycle: { shutdownTime: string; shutdownPolicy: string };
      };
    };

    expect(manifest.apiVersion).toBe(SANDBOX_EXTENSIONS_API_VERSION);
    expect(manifest.kind).toBe("SandboxClaim");
    expect(manifest.spec.sandboxTemplateRef.name).toBe("agent-runtime-claude-warm");
    expect(manifest.spec.lifecycle.shutdownTime).toBe("2026-11-23T00:30:00.000Z");
    expect(manifest.spec.lifecycle.shutdownPolicy).toBe("DeleteForeground");
    expect(manifest.metadata.labels["paperclip.io/run-id"]).toBe("run-01");
  });

  it("rejects non-positive ttlSeconds", () => {
    expect(() =>
      buildSandboxClaimManifest({
        namespace: "ns",
        claimName: "c1",
        templateName: "tpl",
        runId: "r1",
        companyId: "co1",
        ttlSeconds: 0,
      }),
    ).toThrow(/ttlSeconds/);
  });

  it("builds a zero-credential clean SandboxTemplate aligned with PSS restricted baseline", () => {
    const tpl = buildSandboxTemplateManifest({
      namespace: "paperclip",
      templateName: "agent-runtime-claude-warm",
      image: `ghcr.io/paperclipai/agent-runtime-claude@sha256:${"a".repeat(64)}`,
      serviceAccountName: "paperclip-tenant-sa",
      priorityClassName: "paperclip-warm-pool",
      nodeSelector: { "kubernetes.io/arch": "arm64" },
    }) as {
      apiVersion: string;
      kind: string;
      spec: {
        podTemplate: {
          spec: {
            priorityClassName: string;
            nodeSelector: Record<string, string>;
            automountServiceAccountToken: boolean;
            restartPolicy: string;
            containers: Array<{
              name: string;
              envFrom?: unknown;
              securityContext: { readOnlyRootFilesystem: boolean; runAsUser: number };
            }>;
          };
        };
      };
    };

    expect(tpl.apiVersion).toBe("extensions.agents.x-k8s.io/v1beta1");
    expect(tpl.kind).toBe("SandboxTemplate");
    const podSpec = tpl.spec.podTemplate.spec;
    expect(podSpec.priorityClassName).toBe("paperclip-warm-pool");
    expect(podSpec.nodeSelector).toEqual({ "kubernetes.io/arch": "arm64" });
    expect(podSpec.automountServiceAccountToken).toBe(false);
    expect(podSpec.restartPolicy).toBe("Always");
    expect(podSpec.containers[0].name).toBe("agent");
    expect(podSpec.containers[0].envFrom).toBeUndefined();
    expect(podSpec.containers[0].securityContext.readOnlyRootFilesystem).toBe(true);
    expect(podSpec.containers[0].securityContext.runAsUser).toBe(1000);
  });

  it("builds a v1beta1 SandboxWarmPool manifest", () => {
    const pool = buildSandboxWarmPoolManifest({
      namespace: "paperclip",
      poolName: "agent-runtime-claude-warm",
      templateName: "agent-runtime-claude-warm",
      replicas: 4,
    }) as { apiVersion: string; kind: string; spec: { replicas: number } };

    expect(pool.apiVersion).toBe("extensions.agents.x-k8s.io/v1beta1");
    expect(pool.kind).toBe("SandboxWarmPool");
    expect(pool.spec.replicas).toBe(4);
  });
});

describe("waitForSandboxClaimReady & deleteSandboxClaim", () => {
  it("waits until observedGeneration >= generation and verifies Pod Running + restartCount === 0", async () => {
    const getCustom = vi
      .fn()
      .mockResolvedValueOnce({
        metadata: { generation: 2 },
        status: {
          observedGeneration: 1,
          sandbox: { name: "sb-warm-1" },
          conditions: [{ type: "Ready", status: "True" }],
        },
      })
      .mockResolvedValueOnce({
        metadata: { generation: 2 },
        status: {
          observedGeneration: 2,
          sandbox: { name: "sb-warm-1" },
          conditions: [{ type: "Ready", status: "True" }],
        },
      });
    const readPod = vi.fn().mockResolvedValue({
      metadata: { name: "sb-warm-1" },
      status: {
        phase: "Running",
        containerStatuses: [{ name: "agent", restartCount: 0 }],
      },
    });
    const clients = {
      custom: { getNamespacedCustomObject: getCustom },
      core: { readNamespacedPod: readPod },
    };

    const res = await waitForSandboxClaimReady(clients as never, "paperclip-acme", "claim-1", {
      timeoutMs: 2000,
      pollMs: 5,
    });

    expect(getCustom).toHaveBeenCalledTimes(2);
    expect(readPod).toHaveBeenCalledOnce();
    expect(res.sandboxName).toBe("sb-warm-1");
    expect(res.podName).toBe("sb-warm-1");
  });

  it("rejects CrashLoop false-ready pods with restartCount > 0", async () => {
    const clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: { generation: 1 },
          status: {
            observedGeneration: 1,
            sandbox: { name: "sb-crash" },
            conditions: [{ type: "Ready", status: "True" }],
          },
        }),
      },
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue({
          metadata: { name: "sb-crash" },
          status: {
            phase: "Running",
            containerStatuses: [{ name: "agent", restartCount: 2 }],
          },
        }),
      },
    };

    await expect(
      waitForSandboxClaimReady(clients as never, "ns", "claim-crash", {
        timeoutMs: 1000,
        pollMs: 5,
      }),
    ).rejects.toThrow(/restartCount=2/);
  });

  it("throws SandboxClaimTimeoutError when claim never reaches Ready", async () => {
    const clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: { generation: 1 },
          status: { observedGeneration: 1, conditions: [{ type: "Ready", status: "False" }] },
        }),
      },
      core: { readNamespacedPod: vi.fn() },
    };

    await expect(
      waitForSandboxClaimReady(clients as never, "ns", "claim-timeout", {
        timeoutMs: 30,
        pollMs: 5,
      }),
    ).rejects.toBeInstanceOf(SandboxClaimTimeoutError);
  });

  it("creates SandboxClaim via extensions.agents.x-k8s.io/v1beta1 and deletes idempotently on 404", async () => {
    const create = vi.fn().mockResolvedValue({ metadata: { uid: "claim-uid-1" } });
    const del = vi.fn().mockRejectedValue({ code: 404 });
    const clients = {
      custom: {
        createNamespacedCustomObject: create,
        deleteNamespacedCustomObject: del,
      },
    };
    const result = await createSandboxClaim(clients as never, "ns", { kind: "SandboxClaim" });
    expect(result.uid).toBe("claim-uid-1");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        group: "extensions.agents.x-k8s.io",
        version: "v1beta1",
        plural: "sandboxclaims",
      }),
    );
    await expect(deleteSandboxClaim(clients as never, "ns", "claim-1")).resolves.toBeUndefined();
  });
});
