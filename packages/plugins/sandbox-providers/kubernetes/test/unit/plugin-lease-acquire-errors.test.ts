import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { ApiException } from "@kubernetes/client-node";
import {
  createRequest,
  isJsonRpcResponse,
  isRetryableEnvironmentHttpStatus,
  JsonRpcCallError,
  parseMessage,
  readEnvironmentAcquireErrorDiagnostic,
  serializeMessage,
  startWorkerRpcHost,
  type JsonRpcResponse,
  type PluginEnvironmentAcquireLeaseParams,
} from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import plugin from "../../src/plugin.js";

const h = vi.hoisted(() => ({ clients: {} as Record<string, unknown> }));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

const params = {
  driverKey: "kubernetes",
  companyId: "company-1",
  environmentId: "environment-1",
  runId: "run-1",
  config: { inCluster: true, backend: "job", egressMode: "cilium" },
} satisfies PluginEnvironmentAcquireLeaseParams;

function readyTenant() {
  const read = () => vi.fn().mockResolvedValue({});
  return {
    core: {
      readNamespace: read(),
      readNamespacedServiceAccount: read(),
      readNamespacedResourceQuota: read(),
      readNamespacedLimitRange: read(),
    },
    rbac: { readNamespacedRole: read(), readNamespacedRoleBinding: read() },
    networking: { readNamespacedNetworkPolicy: read() },
    custom: { getNamespacedCustomObject: read() },
  };
}

async function acquire(
  settings?: Record<string, unknown>,
): Promise<JsonRpcCallError> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const worker = startWorkerRpcHost({ stdin, stdout, plugin });
  try {
    const response = new Promise<JsonRpcResponse>((resolve) => {
      lines.on("line", (line) => {
        const message = parseMessage(line);
        if (isJsonRpcResponse(message) && message.id === "acquire-test") resolve(message);
      });
    });
    stdin.write(serializeMessage(createRequest("environmentAcquireLease", {
      ...params,
      executionWorkspaceSettings: settings,
    }, "acquire-test")));
    const result = await response;
    if (!("error" in result) || !result.error) throw new Error("Expected RPC error");
    return new JsonRpcCallError(result.error);
  } finally {
    worker.stop();
    lines.close();
    stdin.destroy();
    stdout.destroy();
  }
}

describe("Kubernetes acquire refusal diagnostics", () => {
  it.each([
    { status: 429, retryable: true },
    { status: 503, retryable: true },
    { status: 403, retryable: false },
  ])("preserves a tenant preparation HTTP $status in the worker reply", async ({ status, retryable }) => {
    const error = new ApiException(status, "Tenant read refused", {}, {});
    h.clients = { core: { readNamespace: vi.fn().mockRejectedValue(error) } };

    const result = await acquire();

    expect(result.code).toBe(status);
    expect(result.message).toBe(error.message);
    const diagnostic = readEnvironmentAcquireErrorDiagnostic(result);
    expect(diagnostic).toEqual({ httpStatus: status });
    expect(isRetryableEnvironmentHttpStatus(diagnostic?.httpStatus)).toBe(retryable);
  });

  it.each([99, 600, 429.5, "unrecognized", undefined])(
    "omits an unrecognized tenant refusal code %s",
    async (code) => {
      const error = Object.assign(new Error("Tenant read refused"), { code });
      h.clients = { core: { readNamespace: vi.fn().mockRejectedValue(error) } };

      expect(readEnvironmentAcquireErrorDiagnostic(await acquire())).toBeNull();
    },
  );

  it.each([
    { status: 429, deleteStatus: 404, diagnostic: { httpStatus: 429 }, deletes: 0 },
    { status: 503, deleteStatus: 404, diagnostic: { httpStatus: 503 }, deletes: 1 },
    { status: 503, deleteStatus: 403, diagnostic: null, deletes: 1 },
  ])("handles a refused workload create with HTTP $status and cleanup HTTP $deleteStatus", async ({ status, deleteStatus, diagnostic, deletes }) => {
    const error = new ApiException(status, "Job create refused", {}, {});
    const createNamespacedJob = vi.fn().mockRejectedValue(error);
    const deleteNamespacedJob = vi.fn().mockRejectedValue(new ApiException(deleteStatus, "Job cleanup refused", {}, {}));
    h.clients = {
      ...readyTenant(),
      batch: { createNamespacedJob, deleteNamespacedJob },
    };

    const result = await acquire();

    expect(createNamespacedJob).toHaveBeenCalledOnce();
    expect(deleteNamespacedJob).toHaveBeenCalledTimes(deletes);
    expect(result.code).toBe(status);
    expect(result.message).toBe(error.message);
    expect(readEnvironmentAcquireErrorDiagnostic(result)).toEqual(diagnostic);
  });

  it.each([
    { workloadDeleted: true, diagnostic: { httpStatus: 503 } },
    { workloadDeleted: false, diagnostic: null },
  ])("handles scoped policy refusal when workloadDeleted is $workloadDeleted", async ({ workloadDeleted, diagnostic }) => {
    const tenant = readyTenant();
    const createNamespacedJob = vi.fn().mockResolvedValue({ metadata: { uid: "job-uid" } });
    const deleteNamespacedJob = workloadDeleted
      ? vi.fn().mockResolvedValue({})
      : vi.fn().mockRejectedValue(new ApiException(403, "Job delete refused", {}, {}));
    h.clients = {
      ...tenant,
      batch: { createNamespacedJob, deleteNamespacedJob },
      custom: {
        ...tenant.custom,
        createNamespacedCustomObject: vi.fn().mockRejectedValue(new ApiException(503, "Policy create refused", {}, {})),
      },
    };

    const result = await acquire({ networkEgress: { allowCidrs: ["203.0.113.0/24"] } });

    expect(createNamespacedJob).toHaveBeenCalledOnce();
    expect(deleteNamespacedJob).toHaveBeenCalledOnce();
    expect(readEnvironmentAcquireErrorDiagnostic(result)).toEqual(diagnostic);
  });
});
