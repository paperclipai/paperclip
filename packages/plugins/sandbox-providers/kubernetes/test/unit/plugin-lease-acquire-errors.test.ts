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

vi.mock("../../src/adapter-defaults.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/adapter-defaults.js")>(),
  buildAdapterEnv: vi.fn(() => ({})),
}));

type Backend = "job" | "sandbox-cr";
type FailureStep = "Secret creation" | "pod lookup";

interface Cleanup {
  response: "accepted" | "not found" | "refused";
  workloadGoneAfter: number;
  podsGoneAfter: number;
}

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
  backend: Backend = "job",
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
      config: { ...params.config, backend },
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

function absentJob() {
  return {
    readNamespacedJobStatus: vi.fn().mockRejectedValue(new ApiException(404, "Job absent", {}, {})),
    listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
  };
}

function postClaimFailure(backend: Backend, step: FailureStep, cleanup: Cleanup) {
  const tenant = readyTenant();
  const error = new ApiException(503, `${step} refused`, {}, {});
  const notFound = new ApiException(404, "Resource absent", {}, {});
  const createWorkload = vi.fn().mockResolvedValue({ metadata: { uid: "workload-uid" } });
  const createNamespacedSecret = step === "Secret creation"
    ? vi.fn().mockRejectedValue(error)
    : vi.fn().mockResolvedValue({});
  let deleteRequestedAt: number | undefined;
  const deleteWorkload = vi.fn(async () => {
    deleteRequestedAt = Date.now();
    if (cleanup.response === "not found") throw notFound;
    if (cleanup.response === "refused") throw new ApiException(403, "Workload delete refused", {}, {});
    return {};
  });
  const remains = (goneAfter: number) => deleteRequestedAt === undefined || Date.now() - deleteRequestedAt < goneAfter;
  const readWorkload = vi.fn(async () => {
    if (step === "pod lookup" && backend === "sandbox-cr" && deleteRequestedAt === undefined) throw error;
    if (!remains(cleanup.workloadGoneAfter)) throw notFound;
    return { status: { active: 1, phase: "Terminating" } };
  });
  const listNamespacedPod = vi.fn(async ({ labelSelector }: { labelSelector: string }) => {
    if (step === "pod lookup" && backend === "job" && deleteRequestedAt === undefined) throw error;
    const labels = { "agents.x-k8s.io/sandbox-name": labelSelector.split("=")[1] };
    return { items: remains(cleanup.podsGoneAfter) ? [{ metadata: { name: "old-pod", labels } }] : [] };
  });
  const readNamespacedPod = vi.fn(async ({ name }: { name: string }) => {
    if (!remains(cleanup.podsGoneAfter)) throw notFound;
    return { metadata: { name } };
  });
  h.clients = {
    ...tenant,
    core: { ...tenant.core, createNamespacedSecret, listNamespacedPod, readNamespacedPod },
    batch: {
      createNamespacedJob: createWorkload,
      readNamespacedJobStatus: readWorkload,
      deleteNamespacedJob: deleteWorkload,
    },
    custom: {
      getNamespacedCustomObject: vi.fn(async ({ plural }: { plural: string }) => {
        return plural === "sandboxes" ? readWorkload() : {};
      }),
      createNamespacedCustomObject: createWorkload,
      deleteNamespacedCustomObject: deleteWorkload,
    },
  };
  return { error, createWorkload, createNamespacedSecret, deleteWorkload };
}

async function acquireWithCleanupClock(backend: Backend, settings?: Record<string, unknown>) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    const start = Date.now();
    const result = acquire(settings, backend).then((error) => ({ error, elapsed: Date.now() - start }));
    await vi.advanceTimersByTimeAsync(3_000);
    return await result;
  } finally {
    vi.useRealTimers();
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
    const tenant = readyTenant();
    const { readNamespacedJobStatus, listNamespacedPod } = absentJob();
    const error = new ApiException(status, "Job create refused", {}, {});
    const createNamespacedJob = vi.fn().mockRejectedValue(error);
    const deleteNamespacedJob = vi.fn().mockRejectedValue(new ApiException(deleteStatus, "Job cleanup refused", {}, {}));
    h.clients = {
      ...tenant,
      core: { ...tenant.core, listNamespacedPod },
      batch: { createNamespacedJob, deleteNamespacedJob, readNamespacedJobStatus },
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
    const { readNamespacedJobStatus, listNamespacedPod } = absentJob();
    const createNamespacedJob = vi.fn().mockResolvedValue({ metadata: { uid: "job-uid" } });
    const deleteNamespacedJob = workloadDeleted
      ? vi.fn().mockResolvedValue({})
      : vi.fn().mockRejectedValue(new ApiException(403, "Job delete refused", {}, {}));
    h.clients = {
      ...tenant,
      core: { ...tenant.core, listNamespacedPod },
      batch: { createNamespacedJob, deleteNamespacedJob, readNamespacedJobStatus },
      custom: {
        ...tenant.custom,
        createNamespacedCustomObject: vi.fn().mockRejectedValue(new ApiException(503, "Policy create refused", {}, {})),
      },
    };

    const { error } = await acquireWithCleanupClock("job", { networkEgress: { allowCidrs: ["203.0.113.0/24"] } });

    expect(createNamespacedJob).toHaveBeenCalledOnce();
    expect(deleteNamespacedJob).toHaveBeenCalledOnce();
    expect(readEnvironmentAcquireErrorDiagnostic(error)).toEqual(diagnostic);
  });
});

describe("Kubernetes acquire cleanup deadline", () => {
  it.each(["delete", "workload status", "pod lookup"] as const)(
    "returns the original refusal by two seconds when %s stalls",
    async (step) => {
      const tenant = readyTenant();
      const absent = absentJob();
      const error = new ApiException(503, "Secret creation refused", {}, {});
      const finishStalledRequests: Array<() => void> = [];
      const stall = vi.fn(() => new Promise<never>((_resolve, reject) => {
        finishStalledRequests.push(() => reject(new ApiException(403, "Cleanup call ended", {}, {})));
      }));
      const delayedDelete = vi.fn(() => new Promise<object>((resolve) => {
        setTimeout(() => resolve({}), 750);
      }));
      h.clients = {
        ...tenant,
        core: {
          ...tenant.core,
          createNamespacedSecret: vi.fn().mockRejectedValue(error),
          listNamespacedPod: step === "pod lookup" ? stall : absent.listNamespacedPod,
        },
        batch: {
          createNamespacedJob: vi.fn().mockResolvedValue({ metadata: { uid: "job-uid" } }),
          deleteNamespacedJob: step === "delete" ? stall : delayedDelete,
          readNamespacedJobStatus: step === "workload status" ? stall : absent.readNamespacedJobStatus,
        },
      };

      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      let refusal: JsonRpcCallError | undefined;
      let unexpectedError: unknown;
      const completion = acquire().then(
        (result) => { refusal = result; },
        (failure: unknown) => { unexpectedError = failure; },
      );
      try {
        await vi.advanceTimersByTimeAsync(2_000);
        expect(stall).toHaveBeenCalledOnce();
        expect(unexpectedError).toBeUndefined();
        expect(refusal, "the worker must return the original refusal by the cleanup deadline")
          .toMatchObject({ code: 503, message: error.message });
        expect(readEnvironmentAcquireErrorDiagnostic(refusal)).toBeNull();
      } finally {
        for (const finish of finishStalledRequests) finish();
        await completion;
        vi.useRealTimers();
      }
    },
  );
});

describe.each(["job", "sandbox-cr"] as const)("%s acquire cleanup", (backend) => {
  describe.each(["Secret creation", "pod lookup"] as const)("after %s fails", (step) => {
    it.each([
      { response: "accepted", diagnostic: { httpStatus: 503 } },
      { response: "not found", diagnostic: { httpStatus: 503 } },
      { response: "refused", diagnostic: null },
    ] as const)("preserves the refusal when cleanup is $response", async ({ response, diagnostic }) => {
      const fixture = postClaimFailure(backend, step, { response, workloadGoneAfter: 0, podsGoneAfter: 0 });

      const { error } = await acquireWithCleanupClock(backend);

      expect(fixture.createWorkload).toHaveBeenCalledOnce();
      expect(fixture.createNamespacedSecret).toHaveBeenCalledOnce();
      expect(fixture.deleteWorkload).toHaveBeenCalledOnce();
      expect(error.code).toBe(fixture.error.code);
      expect(error.message).toBe(fixture.error.message);
      expect(readEnvironmentAcquireErrorDiagnostic(error)).toEqual(diagnostic);
    });
  });

  it.each([
    { response: "accepted", workloadGoneAfter: Infinity, podsGoneAfter: Infinity },
    { response: "accepted", workloadGoneAfter: 0, podsGoneAfter: Infinity },
    { response: "not found", workloadGoneAfter: 0, podsGoneAfter: Infinity },
  ] as const)(
    "withholds retry while resources remain after cleanup is $response (workload gone after $workloadGoneAfter ms)",
    async (cleanup) => {
      const fixture = postClaimFailure(backend, "Secret creation", cleanup);

      const { error } = await acquireWithCleanupClock(backend);

      expect(fixture.deleteWorkload).toHaveBeenCalledOnce();
      expect(error.code).toBe(fixture.error.code);
      expect(error.message).toBe(fixture.error.message);
      expect(readEnvironmentAcquireErrorDiagnostic(error)).toBeNull();
    },
  );

  it("reports the original status once the workload and then its pods disappear", async () => {
    const fixture = postClaimFailure(backend, "pod lookup", {
      response: "accepted",
      workloadGoneAfter: 250,
      podsGoneAfter: 750,
    });

    const { error, elapsed } = await acquireWithCleanupClock(backend);

    expect(fixture.deleteWorkload).toHaveBeenCalledOnce();
    expect(error.code).toBe(fixture.error.code);
    expect(error.message).toBe(fixture.error.message);
    expect(readEnvironmentAcquireErrorDiagnostic(error)).toEqual({ httpStatus: 503 });
    expect(elapsed).toBeGreaterThanOrEqual(750);
  });
});
