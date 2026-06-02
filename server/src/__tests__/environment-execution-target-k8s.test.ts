import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockResolveEnvironmentDriverConfigForRuntime,
  mockResolveSecretValue,
} = vi.hoisted(() => ({
  mockResolveEnvironmentDriverConfigForRuntime: vi.fn(),
  mockResolveSecretValue: vi.fn(),
}));

vi.mock("../services/environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: mockResolveEnvironmentDriverConfigForRuntime,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: mockResolveSecretValue,
  }),
}));

import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";

describe("resolveEnvironmentExecutionTarget — k8s", () => {
  beforeEach(() => {
    mockResolveEnvironmentDriverConfigForRuntime.mockReset();
    mockResolveSecretValue.mockReset();
  });

  it("returns a k8s remote target with null kubeconfig (in-cluster auth) when no secret ref provided", async () => {
    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "claude_k8s",
      environment: {
        id: "env-k8s-1",
        driver: "k8s",
        config: {
          namespace: "paperclip",
          workspaceVolumeClaim: "paperclip-data",
          workspaceMountPath: "/workspace",
          nodeSelector: { workload: "paperclip" },
          tolerations: [
            { key: "dedicated", operator: "Equal", value: "paperclip", effect: "NoSchedule" },
          ],
          labels: { team: "infra" },
          serviceAccountName: "paperclip-runner",
          imagePullPolicy: "IfNotPresent",
          resources: {
            requests: { cpu: "100m", memory: "128Mi" },
            limits: { cpu: "1", memory: "1Gi" },
          },
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    if (target == null || target.kind !== "remote" || target.transport !== "k8s") {
      throw new Error(`unexpected target shape: ${JSON.stringify(target)}`);
    }
    expect(target.environmentId).toBe("env-k8s-1");
    expect(target.leaseId).toBe("lease-1");
    expect(target.config.kubeconfig).toBeNull();
    expect(target.config.namespace).toBe("paperclip");
    expect(target.config.workspaceVolumeClaim).toBe("paperclip-data");
    expect(target.config.workspaceMountPath).toBe("/workspace");
    expect(target.config.nodeSelector).toEqual({ workload: "paperclip" });
    expect(target.config.tolerations).toHaveLength(1);
    expect(target.config.tolerations[0]).toMatchObject({
      key: "dedicated",
      operator: "Equal",
      value: "paperclip",
      effect: "NoSchedule",
    });
    expect(target.config.labels).toEqual({ team: "infra" });
    expect(target.config.serviceAccountName).toBe("paperclip-runner");
    expect(target.config.imagePullPolicy).toBe("IfNotPresent");
    expect(target.config.resources).toMatchObject({
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "1", memory: "1Gi" },
    });
    expect(mockResolveSecretValue).not.toHaveBeenCalled();
  });

  it("resolves kubeconfigSecretRef via the secret service", async () => {
    mockResolveSecretValue.mockResolvedValue("apiVersion: v1\nkind: Config\n...");

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-2",
      adapterType: "opencode_k8s",
      environment: {
        id: "env-k8s-2",
        driver: "k8s",
        config: {
          kubeconfigSecretRef: "11111111-1111-1111-1111-111111111111",
          namespace: "agents",
        },
      },
      leaseId: "lease-2",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    if (target == null || target.kind !== "remote" || target.transport !== "k8s") {
      throw new Error(`unexpected target shape: ${JSON.stringify(target)}`);
    }
    expect(mockResolveSecretValue).toHaveBeenCalledWith(
      "company-2",
      "11111111-1111-1111-1111-111111111111",
      "latest",
    );
    expect(target.config.kubeconfig).toBe("apiVersion: v1\nkind: Config\n...");
    expect(target.config.namespace).toBe("agents");
  });

  it("falls back to in-cluster auth when kubeconfigSecretRef is empty string (DB drift)", async () => {
    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-empty-ref",
      adapterType: "claude_k8s",
      environment: {
        id: "env-k8s-empty-ref",
        driver: "k8s",
        config: { namespace: "paperclip", kubeconfigSecretRef: "" },
      },
      leaseId: "lease-empty-ref",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    if (target == null || target.kind !== "remote" || target.transport !== "k8s") {
      throw new Error(`unexpected target shape: ${JSON.stringify(target)}`);
    }
    expect(mockResolveSecretValue).not.toHaveBeenCalled();
    expect(target.config.kubeconfig).toBeNull();
  });

  it("threads providers from environment.config into the k8s remote target", async () => {
    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-providers",
      adapterType: "claude_k8s",
      environment: {
        id: "env-k8s-providers",
        driver: "k8s",
        config: {
          namespace: "paperclip",
          providers: {
            anthropic: { kind: "ccrotate", accounts: ["a@b.net", "c@d.net"] },
          },
        },
      },
      leaseId: "lease-providers",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    if (target == null || target.kind !== "remote" || target.transport !== "k8s") {
      throw new Error(`unexpected target shape: ${JSON.stringify(target)}`);
    }
    expect(target.config.providers).toEqual({
      anthropic: { kind: "ccrotate", accounts: ["a@b.net", "c@d.net"] },
    });
  });

  it("omits providers when absent from environment.config", async () => {
    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-no-providers",
      adapterType: "claude_k8s",
      environment: {
        id: "env-k8s-no-providers",
        driver: "k8s",
        config: { namespace: "paperclip" },
      },
      leaseId: "lease-no-providers",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });
    if (target == null || target.kind !== "remote" || target.transport !== "k8s") {
      throw new Error(`unexpected target shape: ${JSON.stringify(target)}`);
    }
    expect(target.config.providers).toBeUndefined();
  });

  it("does not pass through unknown config keys (defense in depth whitelist)", async () => {
    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-3",
      adapterType: "claude_k8s",
      environment: {
        id: "env-k8s-3",
        driver: "k8s",
        config: {
          namespace: "paperclip",
          maliciousField: "should-not-appear",
          anotherUnknown: 42,
        },
      },
      leaseId: "lease-3",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    if (target == null || target.kind !== "remote" || target.transport !== "k8s") {
      throw new Error(`unexpected target shape: ${JSON.stringify(target)}`);
    }
    expect((target.config as unknown as Record<string, unknown>).maliciousField).toBeUndefined();
    expect((target.config as unknown as Record<string, unknown>).anotherUnknown).toBeUndefined();
    // Whitelisted keys still pass through.
    expect(target.config.namespace).toBe("paperclip");
  });
});
