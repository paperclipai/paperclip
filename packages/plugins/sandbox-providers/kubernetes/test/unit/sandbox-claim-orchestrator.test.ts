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

/**
 * Contract subset derived from kubernetes-sigs/agent-sandbox v1beta1 CRDs
 * (`k8s/crds/extensions.agents.x-k8s.io_sandboxclaims.yaml` and
 * `k8s/crds/extensions.agents.x-k8s.io_sandboxwarmpools.yaml`, commit 1b7d5336).
 */
const V1BETA1_SHUTDOWN_POLICY_ENUM = new Set(["Delete", "DeleteForeground", "Retain"]);

describe("v1beta1 SandboxClaim / SandboxTemplate / SandboxWarmPool builders", () => {
  it("conforms to agent-sandbox v1beta1 SandboxClaim CRD schema (warmPoolRef + lifecycle.shutdownTime/shutdownPolicy)", () => {
    const nowMs = Date.parse("2026-11-23T00:00:00.000Z");
    const manifest = buildSandboxClaimManifest({
      namespace: "paperclip-acme",
      claimName: "claim-01",
      warmPoolName: "agent-runtime-claude-warm",
      runId: "run-01",
      companyId: "comp-01",
      ttlSeconds: 1800,
      nowMs,
    }) as {
      apiVersion: string;
      kind: string;
      metadata: { labels: Record<string, string> };
      spec: {
        warmPoolRef: { name: string };
        sandboxTemplateRef?: unknown;
        lifecycle: { shutdownTime: string; shutdownPolicy: string };
      };
    };

    expect(manifest.apiVersion).toBe(SANDBOX_EXTENSIONS_API_VERSION);
    expect(manifest.kind).toBe("SandboxClaim");
    // v1beta1 SandboxClaim requires spec.warmPoolRef.name (not sandboxTemplateRef).
    expect(manifest.spec.warmPoolRef).toEqual({ name: "agent-runtime-claude-warm" });
    expect(manifest.spec.sandboxTemplateRef).toBeUndefined();
    expect(manifest.spec.lifecycle.shutdownTime).toBe("2026-11-23T00:30:00.000Z");
    expect(Number.isNaN(Date.parse(manifest.spec.lifecycle.shutdownTime))).toBe(false);
    expect(V1BETA1_SHUTDOWN_POLICY_ENUM.has(manifest.spec.lifecycle.shutdownPolicy)).toBe(true);
    expect(manifest.spec.lifecycle.shutdownPolicy).toBe("DeleteForeground");
    expect(manifest.metadata.labels["paperclip.io/run-id"]).toBe("run-01");
  });

  it("rejects non-positive ttlSeconds or empty warmPoolName", () => {
    expect(() =>
      buildSandboxClaimManifest({
        namespace: "ns",
        claimName: "c1",
        warmPoolName: "pool-1",
        runId: "r1",
        companyId: "co1",
        ttlSeconds: 0,
      }),
    ).toThrow(/ttlSeconds/);

    expect(() =>
      buildSandboxClaimManifest({
        namespace: "ns",
        claimName: "c1",
        warmPoolName: "   ",
        runId: "r1",
        companyId: "co1",
      }),
    ).toThrow(/warmPoolName/);
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

  it("builds a v1beta1 SandboxWarmPool manifest with spec.sandboxTemplateRef.name", () => {
    const pool = buildSandboxWarmPoolManifest({
      namespace: "paperclip",
      poolName: "agent-runtime-claude-warm",
      templateName: "agent-runtime-claude-warm",
      replicas: 4,
    }) as {
      apiVersion: string;
      kind: string;
      spec: { replicas: number; sandboxTemplateRef: { name: string } };
    };

    expect(pool.apiVersion).toBe("extensions.agents.x-k8s.io/v1beta1");
    expect(pool.kind).toBe("SandboxWarmPool");
    expect(pool.spec.replicas).toBe(4);
    expect(pool.spec.sandboxTemplateRef).toEqual({ name: "agent-runtime-claude-warm" });
  });
});

describe("waitForSandboxClaimReady & deleteSandboxClaim", () => {
  it("handles a representative v1beta1 controller response (condition-level observedGeneration, no top-level status.observedGeneration)", async () => {
    const getCustom = vi
      .fn()
      // Poll 1: Ready condition carries stale observedGeneration (1 < 2)
      .mockResolvedValueOnce({
        apiVersion: "extensions.agents.x-k8s.io/v1beta1",
        kind: "SandboxClaim",
        metadata: { name: "claim-1", namespace: "paperclip-acme", generation: 2 },
        status: {
          sandbox: { name: "sb-warm-1", podIPs: ["10.42.0.18"], serviceFQDN: "sb-warm-1.paperclip-acme.svc.cluster.local" },
          conditions: [
            {
              type: "Ready",
              status: "True",
              reason: "SandboxReady",
              message: "Sandbox is ready",
              observedGeneration: 1,
              lastTransitionTime: "2026-11-23T00:00:01Z",
            },
          ],
        },
      })
      // Poll 2: Ready condition caught up to generation 2
      .mockResolvedValueOnce({
        apiVersion: "extensions.agents.x-k8s.io/v1beta1",
        kind: "SandboxClaim",
        metadata: { name: "claim-1", namespace: "paperclip-acme", generation: 2 },
        status: {
          sandbox: { name: "sb-warm-1", podIPs: ["10.42.0.18"], serviceFQDN: "sb-warm-1.paperclip-acme.svc.cluster.local" },
          conditions: [
            {
              type: "Ready",
              status: "True",
              reason: "SandboxReady",
              message: "Sandbox is ready",
              observedGeneration: 2,
              lastTransitionTime: "2026-11-23T00:00:02Z",
            },
          ],
        },
      });
    const readPod = vi.fn().mockResolvedValue({
      metadata: { name: "sb-warm-1" },
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "agent", restartCount: 0, state: { running: { startedAt: "2026-11-23T00:00:01Z" } } },
        ],
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

  it("keeps polling when Pod is Running with only a sidecar container status and no agent status yet", async () => {
    const getCustom = vi.fn().mockResolvedValue({
      metadata: { generation: 1 },
      status: {
        sandbox: { name: "sb-sidecar" },
        conditions: [
          {
            type: "Ready",
            status: "True",
            reason: "SandboxReady",
            message: "Sandbox is ready",
            observedGeneration: 1,
            lastTransitionTime: "2026-11-23T00:00:01Z",
          },
        ],
      },
    });
    const readPod = vi
      .fn()
      // Poll 1: sidecar is running, agent container status has not been reported yet
      .mockResolvedValueOnce({
        metadata: { name: "sb-sidecar" },
        status: {
          phase: "Running",
          containerStatuses: [{ name: "istio-proxy", restartCount: 0, state: { running: {} } }],
        },
      })
      // Poll 2: agent container status now present and running with restartCount === 0
      .mockResolvedValueOnce({
        metadata: { name: "sb-sidecar" },
        status: {
          phase: "Running",
          containerStatuses: [
            { name: "istio-proxy", restartCount: 0, state: { running: {} } },
            { name: "agent", restartCount: 0, state: { running: { startedAt: "2026-11-23T00:00:02Z" } } },
          ],
        },
      });
    const clients = {
      custom: { getNamespacedCustomObject: getCustom },
      core: { readNamespacedPod: readPod },
    };

    const res = await waitForSandboxClaimReady(clients as never, "paperclip-acme", "claim-sidecar", {
      timeoutMs: 2000,
      pollMs: 5,
    });

    expect(readPod).toHaveBeenCalledTimes(2);
    expect(res.podName).toBe("sb-sidecar");
  });

  it("keeps polling when agent container has restartCount=0 but is waiting or terminated instead of running", async () => {
    const getCustom = vi.fn().mockResolvedValue({
      metadata: { generation: 1 },
      status: {
        sandbox: { name: "sb-stopped-agent" },
        conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
      },
    });
    const readPod = vi
      .fn()
      .mockResolvedValueOnce({
        metadata: { name: "sb-stopped-agent" },
        status: {
          phase: "Running",
          containerStatuses: [
            { name: "istio-proxy", restartCount: 0, state: { running: {} } },
            { name: "agent", restartCount: 0, state: { waiting: { reason: "ContainerCreating" } } },
          ],
        },
      })
      .mockResolvedValueOnce({
        metadata: { name: "sb-stopped-agent" },
        status: {
          phase: "Running",
          containerStatuses: [
            { name: "istio-proxy", restartCount: 0, state: { running: {} } },
            { name: "agent", restartCount: 0, state: { terminated: { exitCode: 0 } } },
          ],
        },
      })
      .mockResolvedValueOnce({
        metadata: { name: "sb-stopped-agent" },
        status: {
          phase: "Running",
          containerStatuses: [
            { name: "istio-proxy", restartCount: 0, state: { running: {} } },
            { name: "agent", restartCount: 0, state: { running: { startedAt: "2026-11-23T00:00:03Z" } } },
          ],
        },
      });
    const clients = {
      custom: { getNamespacedCustomObject: getCustom },
      core: { readNamespacedPod: readPod },
    };

    const res = await waitForSandboxClaimReady(clients as never, "paperclip-acme", "claim-stopped", {
      timeoutMs: 2000,
      pollMs: 5,
    });

    expect(readPod).toHaveBeenCalledTimes(3);
    expect(res.podName).toBe("sb-stopped-agent");
  });

  it("rejects CrashLoop false-ready pods with restartCount > 0", async () => {
    const clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: { generation: 1 },
          status: {
            sandbox: { name: "sb-crash" },
            conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
          },
        }),
      },
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue({
          metadata: { name: "sb-crash" },
          status: {
            phase: "Running",
            containerStatuses: [{ name: "agent", restartCount: 2, state: { running: {} } }],
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
          status: {
            conditions: [{ type: "Ready", status: "False", reason: "Pending", observedGeneration: 1 }],
          },
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
