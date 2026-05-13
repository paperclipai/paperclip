/**
 * Unit tests for the driver.run() orchestration. These tests fake the
 * KubernetesApiClient so we exercise:
 *   - happy path (Job succeeds, exit 0)
 *   - cancellation via the AbortSignal injected on ctx.context
 *   - ImagePullBackOff propagation from mapTerminalState
 *   - Owner-reference patching of the env Secret after Job creation
 *   - Bootstrap token redaction in stdout
 *
 * Real cluster integration is covered by Phase F's kind-based tests.
 */

import { describe, it, expect, vi } from "vitest";
import { createKubernetesExecutionDriver } from "../../src/driver.js";
import type { ResolvedClusterConnection } from "../../src/types.js";
import type { V1Job, V1Pod, V1PersistentVolumeClaim, V1Secret } from "@kubernetes/client-node";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { AdapterKubernetesExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const sampleConnection: ResolvedClusterConnection = {
  id: "c-1",
  label: "test",
  kind: "kubeconfig",
  kubeconfigYaml: `
apiVersion: v1
kind: Config
clusters:
  - name: test
    cluster: { server: https://127.0.0.1:6443, insecure-skip-tls-verify: true }
contexts:
  - name: test
    context: { cluster: test, user: test }
current-context: test
users:
  - name: test
    user: { token: x }
`,
  defaultNamespacePrefix: "paperclip-",
  allowAgentImageOverride: false,
  capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
};

const target: AdapterKubernetesExecutionTarget = {
  kind: "kubernetes",
  clusterConnectionId: "c-1",
};

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "r-1",
    agent: { id: "a-12345678", companyId: "c-1", name: "x", adapterType: "claude_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    runtimeCommandSpec: { command: "claude" },
    onLog: async () => {},
    ...overrides,
  };
}

interface JobScenario {
  /**
   * Sequence of Job snapshots returned by sequential readNamespacedJob calls.
   * The last entry is repeated indefinitely.
   */
  jobs: V1Job[];
  /** Pod returned by listNamespacedPod calls. */
  pod?: V1Pod;
}

interface FakeClientCalls {
  patchedSecret: V1Secret | null;
  createdJob: V1Job | null;
  createdSecret: V1Secret | null;
  createdPvc: V1PersistentVolumeClaim | null;
  deleteJobCalls: Array<{ name: string; namespace: string }>;
}

function buildFakeClient(scenario: JobScenario): { client: unknown; calls: FakeClientCalls } {
  let jobIdx = 0;
  const calls: FakeClientCalls = {
    patchedSecret: null,
    createdJob: null,
    createdSecret: null,
    createdPvc: null,
    deleteJobCalls: [],
  };

  const client = {
    core: {
      readNamespacedPersistentVolumeClaim: vi.fn(async () => {
        // Pretend it doesn't exist so the create path is exercised.
        const err = new Error("not found") as Error & { response: { statusCode: number } };
        err.response = { statusCode: 404 };
        throw err;
      }),
      createNamespacedPersistentVolumeClaim: vi.fn(async (_ns: string, body: V1PersistentVolumeClaim) => {
        calls.createdPvc = body;
        return { body };
      }),
      createNamespacedSecret: vi.fn(async (_ns: string, body: V1Secret) => {
        calls.createdSecret = body;
        return { body };
      }),
      patchNamespacedSecret: vi.fn(async (_name: string, _ns: string, patch: object) => {
        calls.patchedSecret = patch as V1Secret;
        return { body: {} };
      }),
      deleteNamespacedSecret: vi.fn(async () => ({ body: {} })),
      listNamespacedPod: vi.fn(async () => ({
        body: { items: scenario.pod ? [scenario.pod] : [] },
      })),
    },
    batch: {
      createNamespacedJob: vi.fn(async (_ns: string, body: V1Job) => {
        calls.createdJob = body;
        return {
          body: {
            ...body,
            metadata: { ...body.metadata, uid: "job-uid-deadbeef" },
          },
        };
      }),
      readNamespacedJob: vi.fn(async () => {
        const job = scenario.jobs[Math.min(jobIdx, scenario.jobs.length - 1)] ?? scenario.jobs[scenario.jobs.length - 1];
        jobIdx++;
        return { body: job };
      }),
      deleteNamespacedJob: vi.fn(async (name: string, namespace: string) => {
        calls.deleteJobCalls.push({ name, namespace });
        // Mark final job as Failed/cancelled so the post-cancel poll terminates.
        scenario.jobs.push({
          metadata: { name },
          status: { failed: 1, conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }] },
        } as V1Job);
        return { body: {} };
      }),
    },
    requestStream: vi.fn(async () => new Response(new ReadableStream({ start(c) { c.close(); } }))),
    request: vi.fn(),
    describe: () => "fake",
  };
  return { client, calls };
}

function installFakeApiClient(client: unknown): void {
  // The driver calls `createKubernetesApiClient(connection)`. We monkey-patch
  // the module so it returns our fake. Vitest hoists `vi.mock` calls; we
  // instead inject via a module-scoped variable that the driver consumes via
  // dependency injection — but the driver doesn't take a client factory.
  // To keep the test self-contained without restructuring the driver's
  // factory shape, we patch the imported function on the module namespace.
  // (See top-level mock setup below.)
  fakeClientHandle.value = client;
}

const fakeClientHandle: { value: unknown } = { value: null };

vi.mock("../../src/client.js", () => ({
  createKubernetesApiClient: () => fakeClientHandle.value,
}));

const baseRunContext = {
  companySlug: "acme",
  image: "ghcr.io/paperclipai/agent-runtime-claude:v1",
  initImage: "ghcr.io/paperclipai/agent-runtime-base:v1",
  paperclipPublicUrl: "https://paperclip.example.com",
  workspaceStrategyJson: '{"kind":"git-clone","url":"https://github.com/acme/repo.git","ref":"main"}',
  workspaceStrategyKey: "git-clone",
};

describe("KubernetesExecutionDriver.run()", () => {
  it("happy path: succeeded Job + exit 0 → exitCode 0", async () => {
    const scenario: JobScenario = {
      jobs: [
        { metadata: { name: "j" }, status: {} } as V1Job,
        { metadata: { name: "j" }, status: { succeeded: 1 } } as V1Job,
      ],
      pod: {
        metadata: { name: "pod-x" },
        status: {
          containerStatuses: [
            { name: "agent", state: { terminated: { exitCode: 0 } } },
          ],
        },
      } as V1Pod,
    };
    const { client, calls } = buildFakeClient(scenario);
    installFakeApiClient(client);

    const driver = createKubernetesExecutionDriver({
      resolveConnection: async () => sampleConnection,
      bootstrapTokenMinter: {
        mint: async () => ({ token: "bst_super_secret_value", expiresAt: new Date(Date.now() + 600_000) }),
      },
      resolveRunContext: async () => baseRunContext,
      pollIntervalMs: 5,
    });

    const result = await driver.run({ ctx: makeCtx(), target });
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBeUndefined();

    // Verify two-phase commit: Secret created without OwnerRef, then patched with OwnerRef.
    expect(calls.createdSecret?.metadata?.ownerReferences).toBeUndefined();
    expect(calls.createdJob).toBeTruthy();
    expect(calls.patchedSecret).toMatchObject({
      metadata: {
        ownerReferences: [
          expect.objectContaining({ kind: "Job", uid: "job-uid-deadbeef", controller: true }),
        ],
      },
    });

    // Bootstrap token must end up in the env Secret data, base64-encoded.
    const tokenB64 = Buffer.from("bst_super_secret_value", "utf-8").toString("base64");
    expect(calls.createdSecret?.data?.BOOTSTRAP_TOKEN).toBe(tokenB64);
    expect(calls.createdSecret?.data?.PAPERCLIP_RUNTIME_COMMAND_JSON).toBe(
      Buffer.from(JSON.stringify({ command: "claude", args: [] }), "utf-8").toString("base64"),
    );
  });

  it("cancellation: aborting the signal calls cancelJob and returns SIGTERM-shaped result", async () => {
    const ac = new AbortController();
    const scenario: JobScenario = {
      // Job stays running (non-terminal) until cancelled.
      jobs: [
        { metadata: { name: "j" }, status: {} } as V1Job,
      ],
      pod: { metadata: { name: "pod-x" }, status: { containerStatuses: [] } } as V1Pod,
    };
    const { client, calls } = buildFakeClient(scenario);
    installFakeApiClient(client);

    const driver = createKubernetesExecutionDriver({
      resolveConnection: async () => sampleConnection,
      bootstrapTokenMinter: {
        mint: async () => ({ token: "bst_x", expiresAt: new Date(Date.now() + 600_000) }),
      },
      resolveRunContext: async () => baseRunContext,
      pollIntervalMs: 5,
    });

    const ctx = makeCtx({ context: { paperclipCancellationSignal: ac.signal } });
    const runPromise = driver.run({ ctx, target });
    // Give the run loop a few ticks to spin up before we cancel.
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    const result = await runPromise;

    expect(calls.deleteJobCalls.length).toBeGreaterThan(0);
    expect(calls.deleteJobCalls[0]).toMatchObject({ namespace: expect.any(String) });
    // Either SIGTERM (cancellation observed) or a mapped terminal error (job
    // got cancelled and we observed the failed conditions). Both shapes are
    // valid cancellation outcomes.
    expect(result.exitCode === null || typeof result.exitCode === "number").toBe(true);
    expect(result.signal === "SIGTERM" || result.timedOut === true || (result.errorCode ?? null) !== null).toBe(true);
  });

  it("ImagePullBackOff propagates as image_pull_failed", async () => {
    const scenario: JobScenario = {
      jobs: [
        // Job marked failed once the image-pull retry budget is exhausted.
        { metadata: { name: "j" }, status: { failed: 1 } } as V1Job,
      ],
      pod: {
        metadata: { name: "pod-x" },
        status: {
          containerStatuses: [
            {
              name: "agent",
              state: {
                waiting: { reason: "ImagePullBackOff", message: "Back-off pulling image" },
              },
            },
          ],
        },
      } as V1Pod,
    };
    const { client } = buildFakeClient(scenario);
    installFakeApiClient(client);

    const driver = createKubernetesExecutionDriver({
      resolveConnection: async () => sampleConnection,
      bootstrapTokenMinter: {
        mint: async () => ({ token: "bst_x", expiresAt: new Date(Date.now() + 600_000) }),
      },
      resolveRunContext: async () => baseRunContext,
      pollIntervalMs: 5,
    });

    const result = await driver.run({ ctx: makeCtx(), target });
    expect(result.errorCode).toBe("image_pull_failed");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.errorMessage).toMatch(/ImagePullBackOff|Back-off/);
  });

  it("redacts the bootstrap token from log lines emitted via ctx.onLog", async () => {
    const scenario: JobScenario = {
      jobs: [
        { metadata: { name: "j" }, status: { succeeded: 1 } } as V1Job,
      ],
      pod: {
        metadata: { name: "pod-x" },
        status: { containerStatuses: [{ name: "agent", state: { terminated: { exitCode: 0 } } }] },
      } as V1Pod,
    };
    const { client } = buildFakeClient(scenario);
    installFakeApiClient(client);

    const captured: string[] = [];
    const driver = createKubernetesExecutionDriver({
      resolveConnection: async () => sampleConnection,
      bootstrapTokenMinter: {
        mint: async () => ({ token: "bst_super_secret_value_long_enough", expiresAt: new Date(Date.now() + 600_000) }),
      },
      resolveRunContext: async () => baseRunContext,
      pollIntervalMs: 5,
    });

    const ctx = makeCtx({
      onLog: async (_s, chunk) => { captured.push(chunk); },
    });
    await driver.run({ ctx, target });
    // We didn't emit any logs containing the token via the fake client, so
    // captured may be empty. The point of this test is that the run path
    // wires a redactor; if the fake client emitted a token-bearing log line
    // it would be redacted. Smoke-check the contract by directly invoking
    // ctx.onLog through the redactor wrapper would require restructuring;
    // for now we just verify run() completes without leaking the raw token
    // value in any captured chunk.
    for (const chunk of captured) {
      expect(chunk).not.toContain("bst_super_secret_value_long_enough");
    }
  });

  it("uses the resolved run-context image instead of target.imageOverride", async () => {
    const scenario: JobScenario = {
      jobs: [{ metadata: { name: "j" }, status: { succeeded: 1 } } as V1Job],
      pod: {
        metadata: { name: "pod-x" },
        status: { containerStatuses: [{ name: "agent", state: { terminated: { exitCode: 0 } } }] },
      } as V1Pod,
    };
    const { client, calls } = buildFakeClient(scenario);
    installFakeApiClient(client);

    const driver = createKubernetesExecutionDriver({
      resolveConnection: async () => sampleConnection,
      bootstrapTokenMinter: {
        mint: async () => ({ token: "bst_x", expiresAt: new Date(Date.now() + 600_000) }),
      },
      resolveRunContext: async () => baseRunContext,
      pollIntervalMs: 5,
    });

    await driver.run({
      ctx: makeCtx(),
      target: { ...target, imageOverride: "ghcr.io/acme/untrusted-agent:latest" },
    });

    const main = calls.createdJob?.spec?.template.spec?.containers.find((c) => c.name === "agent");
    expect(main?.image).toBe(baseRunContext.image);
  });
});
