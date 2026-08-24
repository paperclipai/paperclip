import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  createHostClientHandlers,
  JsonRpcCallError,
  PLUGIN_RPC_ERROR_CODES,
  type HostServices,
  type HostToWorkerMethods,
} from "@paperclipai/plugin-sdk";
import {
  appendStderrExcerpt,
  createPluginWorkerHandle,
  formatWorkerFailureMessage,
  resolveRpcCallTimeoutMs,
} from "../services/plugin-worker-manager.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const DELAYED_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-delayed.cjs");
const INVOCATION_SCOPE_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-invocation-scope.cjs",
);
const TERMINATED_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-terminated.cjs");
const EXECUTE_LOG_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-execute-log.cjs");

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

describe("resolveRpcCallTimeoutMs", () => {
  const MAX_RPC_TIMEOUT_MS = 15 * 60 * 1_000;
  const MAX_NODE_TIMER_TIMEOUT_MS = 2_147_483_647;
  const DEFAULT_RPC_TIMEOUT_MS = 30_000;

  it("honors an explicit timeout above the 15-minute default ceiling", () => {
    // The sandbox environment driver requests ~4h + 30s buffer for
    // environmentExecute; this must not be clamped to 15 minutes.
    const fourHoursPlusBuffer = 4 * 60 * 60 * 1_000 + 30_000;
    expect(resolveRpcCallTimeoutMs(fourHoursPlusBuffer, DEFAULT_RPC_TIMEOUT_MS)).toBe(
      fourHoursPlusBuffer,
    );
  });

  it("honors an explicit timeout below the ceiling", () => {
    expect(resolveRpcCallTimeoutMs(100, DEFAULT_RPC_TIMEOUT_MS)).toBe(100);
    expect(resolveRpcCallTimeoutMs(MAX_RPC_TIMEOUT_MS - 1, DEFAULT_RPC_TIMEOUT_MS)).toBe(
      MAX_RPC_TIMEOUT_MS - 1,
    );
  });

  it("truncates fractional explicit timeouts", () => {
    expect(resolveRpcCallTimeoutMs(1_000.9, DEFAULT_RPC_TIMEOUT_MS)).toBe(1_000);
  });

  it("normalizes explicit timeouts to Node's timer-safe range", () => {
    expect(resolveRpcCallTimeoutMs(0.5, DEFAULT_RPC_TIMEOUT_MS)).toBe(1);
    expect(resolveRpcCallTimeoutMs(MAX_NODE_TIMER_TIMEOUT_MS + 1, DEFAULT_RPC_TIMEOUT_MS)).toBe(
      MAX_NODE_TIMER_TIMEOUT_MS,
    );
  });

  it("uses the default timeout when no explicit timeout is provided", () => {
    expect(resolveRpcCallTimeoutMs(undefined, DEFAULT_RPC_TIMEOUT_MS)).toBe(
      DEFAULT_RPC_TIMEOUT_MS,
    );
  });

  it("clamps only the default path to the 15-minute ceiling", () => {
    expect(resolveRpcCallTimeoutMs(undefined, 24 * 60 * 60 * 1_000)).toBe(MAX_RPC_TIMEOUT_MS);
  });

  it("falls back to the clamped default for unusable explicit timeouts", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveRpcCallTimeoutMs(bad, DEFAULT_RPC_TIMEOUT_MS)).toBe(DEFAULT_RPC_TIMEOUT_MS);
    }
    expect(resolveRpcCallTimeoutMs(Number.NaN, 24 * 60 * 60 * 1_000)).toBe(MAX_RPC_TIMEOUT_MS);
  });
});

describe("plugin-worker-manager stderr failure context", () => {
  it("appends worker stderr context to failure messages", () => {
    expect(
      formatWorkerFailureMessage(
        "Worker process exited (code=1, signal=null)",
        "TypeError: Unknown file extension \".ts\"",
      ),
    ).toBe(
      "Worker process exited (code=1, signal=null)\n\nWorker stderr:\nTypeError: Unknown file extension \".ts\"",
    );
  });

  it("does not duplicate stderr that is already present", () => {
    const message = [
      "Worker process exited (code=1, signal=null)",
      "",
      "Worker stderr:",
      "TypeError: Unknown file extension \".ts\"",
    ].join("\n");

    expect(
      formatWorkerFailureMessage(message, "TypeError: Unknown file extension \".ts\""),
    ).toBe(message);
  });

  it("keeps only the latest stderr excerpt", () => {
    let excerpt = "";
    excerpt = appendStderrExcerpt(excerpt, "first line");
    excerpt = appendStderrExcerpt(excerpt, "second line");

    expect(excerpt).toContain("first line");
    expect(excerpt).toContain("second line");

    excerpt = appendStderrExcerpt(excerpt, "x".repeat(9_000));

    expect(excerpt).not.toContain("first line");
    expect(excerpt).not.toContain("second line");
    expect(excerpt.length).toBeLessThanOrEqual(8_000);
  });

  it("times out environmentExecute calls using the handle default when no override is provided", async () => {
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: DELAYED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: {},
      rpcTimeoutMs: 10,
    });

    try {
      await handle.start();

      await expect(handle.call("environmentExecute", {
        driverKey: "e2b",
        companyId: "company-1",
        environmentId: "environment-1",
        config: {},
        lease: { providerLeaseId: "lease-1" },
        command: "echo",
        delayMs: 50,
      } as HostToWorkerMethods["environmentExecute"][0])).rejects.toMatchObject({
        message: expect.stringContaining("timed out after 10ms"),
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("honors per-call timeout overrides for environmentExecute", async () => {
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: DELAYED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: {},
      rpcTimeoutMs: 10,
    });

    try {
      await handle.start();

      await expect(handle.call("environmentExecute", {
        driverKey: "e2b",
        companyId: "company-1",
        environmentId: "environment-1",
        config: {},
        lease: { providerLeaseId: "lease-1" },
        command: "echo",
        delayMs: 50,
      } as HostToWorkerMethods["environmentExecute"][0], 100)).resolves.toMatchObject({
        exitCode: 0,
        stdout: "ok\n",
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("does not emit an unhandled rejection when a plugin responds with terminated before callers attach handlers", async () => {
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);

    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: TERMINATED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: {},
    });

    try {
      await handle.start();

      const pendingCall = handle.call(
        "environmentExecute" as keyof HostToWorkerMethods,
        {
          driverKey: "e2b",
          companyId: "company-1",
          environmentId: "environment-1",
          config: {},
          lease: { providerLeaseId: "lease-1" },
          command: "echo",
        } as HostToWorkerMethods[keyof HostToWorkerMethods][0],
      );

      await new Promise((resolve) => setImmediate(resolve));

      await expect(pendingCall).rejects.toBeInstanceOf(JsonRpcCallError);
      await expect(pendingCall).rejects.toMatchObject({
        message: expect.stringContaining("terminated"),
      });
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
      await handle.stop().catch(() => undefined);
    }
  });

  it("passes performAction invocation scope to nested worker host calls", async () => {
    const companiesGet = vi.fn(async (
      params: { companyId: string },
      context?: { invocationScope?: { companyId?: string | null } | null },
    ) => ({
      id: params.companyId,
      scopedCompanyId: context?.invocationScope?.companyId ?? null,
    }));
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: {
        "companies.get": companiesGet as never,
      },
    });

    try {
      await handle.start();

      await expect(handle.call("performAction", {
        key: "probe",
        params: {
          mode: "echo",
          requestedCompanyId: "company-a",
        },
        actorContext: {
          type: "agent",
          userId: null,
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-a",
        },
        renderEnvironment: null,
      })).resolves.toEqual({
        id: "company-a",
        scopedCompanyId: "company-a",
      });
      expect(companiesGet).toHaveBeenCalledWith(
        { companyId: "company-a" },
        { invocationScope: { companyId: "company-a" } },
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("passes echoed invocation scope to worker-to-host handlers", async () => {
    const companiesGet = vi.fn(async () => ({ id: "company-1" }));
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: {
        "companies.get": companiesGet,
      },
    });

    try {
      await handle.start();

      await expect(handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: {
          mode: "echo",
          requestedCompanyId: "company-1",
        },
      } as HostToWorkerMethods["getData"][0])).resolves.toEqual({ id: "company-1" });

      expect(companiesGet).toHaveBeenCalledWith(
        { companyId: "company-1" },
        { invocationScope: { companyId: "company-1" } },
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects performAction nested host calls that omit the invocation id", async () => {
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          list: vi.fn(async () => []),
          get: vi.fn(async (params: { companyId: string }) => ({ id: params.companyId })),
        },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: handlers,
    });

    try {
      await handle.start();

      await expect(handle.call("performAction", {
        key: "probe",
        params: {
          requestedCompanyId: "company-b",
        },
        actorContext: {
          type: "agent",
          userId: null,
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-a",
        },
        renderEnvironment: null,
      })).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining("unknown invocation scope"),
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects nested worker host calls that forge an unknown invocation id", async () => {
    const companiesGet = vi.fn(async (params: { companyId: string }) => ({ id: params.companyId }));
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          get: companiesGet,
        },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: handlers,
    });

    try {
      await handle.start();

      await expect(handle.call("performAction", {
        key: "probe",
        params: {
          mode: "unknown",
          requestedCompanyId: "company-a",
        },
        actorContext: {
          type: "agent",
          userId: null,
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-a",
        },
        renderEnvironment: null,
      })).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining("unknown invocation scope"),
      });
      expect(companiesGet).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects missing or unknown invocation ids while a company invocation is active", async () => {
    const companiesGet = vi.fn(async () => ({ id: "company-2" }));
    const hostHandlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          get: companiesGet,
        },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers,
    });

    try {
      await handle.start();

      for (const mode of ["omit", "unknown"]) {
        await expect(handle.call("getData", {
          key: "probe",
          companyId: "company-1",
          params: {
            mode,
            requestedCompanyId: "company-2",
          },
        } as HostToWorkerMethods["getData"][0])).rejects.toMatchObject({
          code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        });
      }

      expect(companiesGet).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});


describe("plugin host company context guards", () => {
  it("rejects config and secret calls without host-issued company context before host services run", async () => {
    const configGet = vi.fn(async () => ({ apiKey: "unreachable" }));
    const secretsResolve = vi.fn(async () => "unreachable");
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["secrets.read-ref"],
      services: {
        config: { get: configGet },
        secrets: { resolve: secretsResolve },
      } as unknown as HostServices,
    });

    await expect(handlers["config.get"]({})).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });
    await expect(handlers["config.get"]({ companyId: "company-1" })).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });
    await expect(
      handlers["secrets.resolve"]({
        secretRef: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" },
      }),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });
    await expect(
      handlers["secrets.resolve"]({
        companyId: "company-1",
        secretRef: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" },
      }),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });

    expect(configGet).not.toHaveBeenCalled();
    expect(secretsResolve).not.toHaveBeenCalled();
  });

  it("rejects cross-company config and secret reads in scoped worker invocations before host services run", async () => {
    const configGet = vi.fn(async () => ({ apiKeyRef: "unreachable" }));
    const secretsResolve = vi.fn(async () => "unreachable");
    const hostHandlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["secrets.read-ref"],
      services: {
        config: { get: configGet },
        secrets: { resolve: secretsResolve },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers,
    });

    try {
      await handle.start();

      for (const hostMethod of ["config.get", "secrets.resolve"] as const) {
        await expect(handle.call("performAction", {
          key: "probe",
          params: {
            mode: "echo",
            hostMethod,
            requestedCompanyId: "company-b",
          },
          actorContext: {
            type: "agent",
            userId: null,
            agentId: "agent-1",
            runId: "run-1",
            companyId: "company-a",
          },
          renderEnvironment: null,
        })).rejects.toMatchObject({
          code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
          message: expect.stringContaining('requested company "company-b"'),
        });
      }

      expect(configGet).not.toHaveBeenCalled();
      expect(secretsResolve).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});


describe("plugin proactive company scope (LOOA-629)", () => {
  // A proactive plugin (e.g. the chat gateway) makes company-scoped worker→host
  // calls from its own timers/loops — outside any host-issued invocation, so
  // those calls carry no paperclipInvocationId (the fixture's "omit" mode). The
  // host authorizes a bounded set of companies for such proactive work; calls
  // referencing an authorized company resolve to that scope, all others stay
  // denied. Each case drives a real worker so the nested call flows through the
  // worker manager's context resolution, not just the SDK gate in isolation.
  function makeHandle(overrides?: {
    companiesGet?: ReturnType<typeof vi.fn>;
    stateGet?: ReturnType<typeof vi.fn>;
  }) {
    const companiesGet = overrides?.companiesGet ?? vi.fn(async () => ({ id: "company-1", name: "Co" }));
    const stateGet = overrides?.stateGet ?? vi.fn(async () => ({ value: "ok" }));
    const hostHandlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["companies.read", "plugin.state.read"],
      services: {
        companies: { get: companiesGet },
        state: { get: stateGet },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers,
    });
    return { handle, companiesGet, stateGet };
  }

  it("denies a proactive company-scoped call when no company is authorized", async () => {
    const { handle, companiesGet } = makeHandle();
    try {
      await handle.start();
      await expect(handle.call("getData", {
        params: { mode: "omit", hostMethod: "companies.get", requestedCompanyId: "company-1" },
      } as unknown as HostToWorkerMethods["getData"][0])).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining("company context is required"),
      });
      expect(companiesGet).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("admits a proactive company-scoped call for an authorized company", async () => {
    const { handle, companiesGet } = makeHandle();
    try {
      await handle.start();
      handle.setProactiveCompanyScopes(["company-1"]);
      const result = await handle.call("getData", {
        params: { mode: "omit", hostMethod: "companies.get", requestedCompanyId: "company-1" },
      } as unknown as HostToWorkerMethods["getData"][0]);
      expect(result).toMatchObject({ id: "company-1" });
      expect(companiesGet).toHaveBeenCalledTimes(1);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("admits a proactive state.get (scopeKind company) for an authorized company", async () => {
    const { handle, stateGet } = makeHandle();
    try {
      await handle.start();
      handle.setProactiveCompanyScopes(["company-1"]);
      const result = await handle.call("getData", {
        params: { mode: "omit", hostMethod: "state.get", requestedCompanyId: "company-1" },
      } as unknown as HostToWorkerMethods["getData"][0]);
      expect(result).toMatchObject({ value: "ok" });
      expect(stateGet).toHaveBeenCalledTimes(1);
      expect(stateGet.mock.calls[0]?.[0]).toMatchObject({ scopeKind: "company", scopeId: "company-1" });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("still denies proactive calls for a company outside the authorized set", async () => {
    const { handle, companiesGet } = makeHandle();
    try {
      await handle.start();
      handle.setProactiveCompanyScopes(["company-1"]);
      await expect(handle.call("getData", {
        params: { mode: "omit", hostMethod: "companies.get", requestedCompanyId: "company-2" },
      } as unknown as HostToWorkerMethods["getData"][0])).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining("company context is required"),
      });
      expect(companiesGet).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("revokes proactive access when the authorized set is cleared", async () => {
    const { handle, companiesGet } = makeHandle();
    try {
      await handle.start();
      handle.setProactiveCompanyScopes(["company-1"]);
      await handle.call("getData", {
        params: { mode: "omit", hostMethod: "companies.get", requestedCompanyId: "company-1" },
      } as unknown as HostToWorkerMethods["getData"][0]);
      expect(companiesGet).toHaveBeenCalledTimes(1);

      handle.setProactiveCompanyScopes([]);
      await expect(handle.call("getData", {
        params: { mode: "omit", hostMethod: "companies.get", requestedCompanyId: "company-1" },
      } as unknown as HostToWorkerMethods["getData"][0])).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
      });
      expect(companiesGet).toHaveBeenCalledTimes(1);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});

describe("plugin proactive events.subscribe: options-seeded scope + filter parity (LOOA-695)", () => {
  // The chat gateway subscribes to issue.*/approval.* from setup() via
  // ctx.events.on(name, { companyId }, fn), which the SDK turns into a proactive
  // (no-invocation) events.subscribe whose company lives in params.filter.companyId.
  // Two things had to hold for outbound push to work and neither did before this
  // fix:
  //   (1) the authorized company set must be present BEFORE the worker's setup()
  //       calls land — the loader used to set it only after startWorker resolved,
  //       so it was seeded via WorkerStartOptions at handle creation instead;
  //   (2) the host's proactive-scope resolver (referencedCompanyId) must derive
  //       events.subscribe's company from filter.companyId, mirroring the SDK
  //       gate (requestedCompanyScope).
  // Each case drives a real worker so the subscribe flows through the manager's
  // context resolution exactly as it does in production.
  function makeEventsHandle(seededCompanies: readonly string[]) {
    const eventsSubscribe = vi.fn(async () => undefined);
    const hostHandlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["events.subscribe"],
      services: {
        events: { subscribe: eventsSubscribe },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers,
      // Seeded at handle creation — the loader now threads the plugin's
      // configured companies here BEFORE startWorker, never via a post-start
      // setProactiveCompanyScopes call.
      proactiveCompanyScopes: seededCompanies,
    });
    return { handle, eventsSubscribe };
  }

  it("admits a setup()-time events.subscribe for a company seeded via WorkerStartOptions", async () => {
    const { handle, eventsSubscribe } = makeEventsHandle(["company-1"]);
    try {
      await handle.start();
      // No post-start setProactiveCompanyScopes call: the seed from options is
      // the only authorization, exactly as it is when the worker subscribes
      // during setup() before startWorker resolves.
      await handle.call("getData", {
        params: { mode: "omit", hostMethod: "events.subscribe", requestedCompanyId: "company-1" },
      } as unknown as HostToWorkerMethods["getData"][0]);
      expect(eventsSubscribe).toHaveBeenCalledTimes(1);
      expect(eventsSubscribe.mock.calls[0]?.[0]).toMatchObject({
        filter: { companyId: "company-1" },
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("still denies a proactive events.subscribe for a company outside the seeded set", async () => {
    const { handle, eventsSubscribe } = makeEventsHandle(["company-1"]);
    try {
      await handle.start();
      await expect(handle.call("getData", {
        params: { mode: "omit", hostMethod: "events.subscribe", requestedCompanyId: "company-2" },
      } as unknown as HostToWorkerMethods["getData"][0])).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining("company context is required"),
      });
      expect(eventsSubscribe).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("denies a proactive events.subscribe when no company is seeded", async () => {
    const { handle, eventsSubscribe } = makeEventsHandle([]);
    try {
      await handle.start();
      await expect(handle.call("getData", {
        params: { mode: "omit", hostMethod: "events.subscribe", requestedCompanyId: "company-1" },
      } as unknown as HostToWorkerMethods["getData"][0])).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
      });
      expect(eventsSubscribe).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// execute.log worker→host notification route
// ---------------------------------------------------------------------------

function makeExecuteLogHandle(extra?: Record<string, unknown>) {
  return createPluginWorkerHandle("test.plugin", {
    entrypointPath: EXECUTE_LOG_WORKER_ENTRYPOINT,
    manifest: TEST_MANIFEST,
    config: {},
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: {},
    ...extra,
  });
}

function executeParams(
  overrides: Record<string, unknown>,
): HostToWorkerMethods["environmentExecute"][0] {
  return {
    driverKey: "daytona",
    companyId: "company-1",
    environmentId: "env-1",
    config: {},
    lease: { providerLeaseId: "lease-1" },
    command: "echo",
    ...overrides,
  } as unknown as HostToWorkerMethods["environmentExecute"][0];
}

describe("plugin worker manager execute.log route", () => {
  it("delivers ordered execute.log chunks to the execute log sink", async () => {
    const handle = makeExecuteLogHandle();
    const sink = vi.fn();
    try {
      await handle.start();
      const result = await handle.call(
        "environmentExecute",
        executeParams({
          logs: [
            { stream: "stdout", chunk: "one" },
            { stream: "stderr", chunk: "two" },
            { stream: "stdout", chunk: "three" },
          ],
          finalStdout: "onethree",
          finalStderr: "two",
        }),
        undefined,
        sink,
      );
      expect(result).toMatchObject({ exitCode: 0 });
      expect(sink.mock.calls).toEqual([
        ["stdout", "one"],
        ["stderr", "two"],
        ["stdout", "three"],
      ]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("drops an execute.log chunk with a forged or missing invocation id", async () => {
    const handle = makeExecuteLogHandle();
    const sink = vi.fn();
    try {
      await handle.start();
      await handle.call(
        "environmentExecute",
        executeParams({
          logs: [
            { stream: "stdout", chunk: "valid", tag: "echo" },
            { stream: "stdout", chunk: "forged", tag: "unknown" },
            { stream: "stdout", chunk: "orphan", tag: "none" },
          ],
        }),
        undefined,
        sink,
      );
      // Only the chunk that carries this call's own host-issued id is delivered.
      expect(sink.mock.calls).toEqual([["stdout", "valid"]]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("drops an execute.log chunk with an invalid stream name or an empty chunk", async () => {
    const handle = makeExecuteLogHandle();
    const sink = vi.fn();
    try {
      await handle.start();
      await handle.call(
        "environmentExecute",
        executeParams({
          logs: [
            { stream: "stdout", chunk: "keep" },
            { stream: "bogus", chunk: "dropped-stream" },
            { stream: "stdout", chunk: "" },
          ],
        }),
        undefined,
        sink,
      );
      expect(sink.mock.calls).toEqual([["stdout", "keep"]]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("routes two concurrent same-company execute calls to their own sink only", async () => {
    const handle = makeExecuteLogHandle();
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    try {
      await handle.start();
      const callA = handle.call(
        "environmentExecute",
        executeParams({
          companyId: "company-1",
          logs: [{ stream: "stdout", chunk: "a1" }],
          delayMs: 40,
        }),
        undefined,
        sinkA,
      );
      const callB = handle.call(
        "environmentExecute",
        executeParams({
          companyId: "company-1",
          logs: [{ stream: "stdout", chunk: "b1" }],
          delayMs: 40,
        }),
        undefined,
        sinkB,
      );
      await Promise.all([callA, callB]);
      // Both calls belong to one company, so the shared pipe stays
      // single-company and each chunk reaches only its own call's sink.
      expect(sinkA.mock.calls).toEqual([["stdout", "a1"]]);
      expect(sinkB.mock.calls).toEqual([["stdout", "b1"]]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("fails closed and never delivers execute.log across companies, even with a forged peer id", async () => {
    // A single worker process serves every company, so it knows both companies'
    // active invocation ids. While company B's execute stays active, company A's
    // execute forges B's known, valid id and aims a chunk at B's route. The host
    // must not deliver it to B. Before the exact-company-scope validation, the
    // route lookup by the worker-supplied id delivered the forged chunk to B.
    const handle = makeExecuteLogHandle();
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    try {
      await handle.start();
      // Company B opens first and stays active (delayed finish), so its route is
      // registered and known to the worker when company A runs.
      const callB = handle.call(
        "environmentExecute",
        executeParams({ companyId: "company-b", logs: [], delayMs: 200 }),
        undefined,
        sinkB,
      );
      // Let the worker process B's execute, so it records B's id as the peer id.
      await new Promise((resolve) => setTimeout(resolve, 40));
      const callA = handle.call(
        "environmentExecute",
        executeParams({
          companyId: "company-a",
          logs: [{ stream: "stdout", chunk: "forged-into-b", tag: "forge-previous" }],
        }),
        undefined,
        sinkA,
      );
      await Promise.all([callA, callB]);
      expect(sinkB).not.toHaveBeenCalled();
      expect(sinkA).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("drops execute.log chunks once one execute call exceeds its output budget", async () => {
    // Bound the total streamed output for one execute call. Past the ceiling the
    // host drops further chunks, so one runaway or hostile execution cannot flood
    // the host without limit.
    const handle = makeExecuteLogHandle({
      executeLogLimits: { maxTotalCharsPerExecute: 10 },
    });
    const sink = vi.fn();
    try {
      await handle.start();
      await handle.call(
        "environmentExecute",
        executeParams({
          logs: [
            { stream: "stdout", chunk: "aaaaa" }, // total 5 → delivered
            { stream: "stdout", chunk: "bbbbb" }, // total 10 → delivered
            { stream: "stdout", chunk: "c" }, // total 11 > 10 → dropped
          ],
        }),
        undefined,
        sink,
      );
      expect(sink.mock.calls).toEqual([
        ["stdout", "aaaaa"],
        ["stdout", "bbbbb"],
      ]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("drops an over-length worker line before parsing it and keeps serving the call", async () => {
    // Enforce the framing bound before the JSON parse. The oversized note is a
    // valid execute.log line for this call's own id, so without the pre-parse
    // guard the host would parse and deliver it. The normal note stays under the
    // limit and reaches the sink, and the call still completes.
    const handle = makeExecuteLogHandle({
      executeLogLimits: { maxIncomingMessageChars: 400 },
    });
    const sink = vi.fn();
    try {
      await handle.start();
      const result = await handle.call(
        "environmentExecute",
        executeParams({
          oversizedLogChunkChars: 1_000,
          logs: [{ stream: "stdout", chunk: "kept" }],
          finalStdout: "kept",
        }),
        undefined,
        sink,
      );
      expect(result).toMatchObject({ exitCode: 0 });
      expect(sink.mock.calls).toEqual([["stdout", "kept"]]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("completes an execute call that sends no execute.log notification", async () => {
    const handle = makeExecuteLogHandle();
    const sink = vi.fn();
    try {
      await handle.start();
      const result = await handle.call(
        "environmentExecute",
        executeParams({ logs: [], finalStdout: "done" }),
        undefined,
        sink,
      );
      expect(result).toMatchObject({ exitCode: 0, stdout: "done" });
      expect(sink).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("does not throw when execute.log arrives but no sink is registered", async () => {
    const handle = makeExecuteLogHandle();
    try {
      await handle.start();
      const result = await handle.call(
        "environmentExecute",
        executeParams({ logs: [{ stream: "stdout", chunk: "no-sink" }] }),
      );
      expect(result).toMatchObject({ exitCode: 0 });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Host-owned setup-token login pseudo-terminal route gate
// ---------------------------------------------------------------------------

const LOGIN_PTY_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-login-pty.cjs",
);

function makeLoginPtyHandle(extra?: Record<string, unknown>) {
  return createPluginWorkerHandle("test.plugin", {
    entrypointPath: LOGIN_PTY_WORKER_ENTRYPOINT,
    manifest: TEST_MANIFEST,
    config: {},
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: {},
    ...extra,
  });
}

// One valid session home. The shape is the fixed root, one slash, and one UUID.
const PTY_SESSION_HOME = "/tmp/paperclip-adapter-login/11111111-2222-4333-8444-555555555555";

function ptyOpenInput(directive: unknown) {
  return {
    driverKey: "daytona",
    companyId: "company-1",
    environmentId: "env-1",
    // The test directive rides in `providerLeaseId`, an opaque field the manager
    // forwards to the worker unchanged. The manager carries the closed command
    // key and the validated session home; it carries no command string.
    providerLeaseId: JSON.stringify(directive),
    loginCommandKey: "claude" as const,
    sessionHome: PTY_SESSION_HOME,
  };
}

describe("plugin worker manager setup-token pty route gate", () => {
  it("rejects a command key that is not in the closed set before the worker call", async () => {
    const handle = makeLoginPtyHandle();
    try {
      await handle.start();
      // The provider driver key routes the worker; it confers no command
      // authority. A key outside the closed set rejects with one fixed non-secret
      // error before the worker call, so a caller cannot select an arbitrary
      // command in the sandbox pseudo-terminal.
      await expect(
        handle.openLoginPtySession({
          driverKey: "daytona",
          companyId: "company-1",
          environmentId: "env-1",
          providerLeaseId: JSON.stringify({ mode: "normal" }),
          loginCommandKey: "gemini" as unknown as "claude",
          sessionHome: PTY_SESSION_HOME,
        }),
      ).rejects.toThrow("LOGIN_PTY_COMMAND_NOT_ALLOWED");
      // The rejected open never consumed the single route, so a later open with a
      // closed key still succeeds.
      const session = await handle.openLoginPtySession(
        ptyOpenInput({ mode: "normal" }),
      );
      expect(session).toBeDefined();
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects a malformed session home before the worker call", async () => {
    const handle = makeLoginPtyHandle();
    try {
      await handle.start();
      // The host revalidates the server-controlled session home shape before the
      // worker RPC. A traversal candidate fails closed at the last host gate.
      await expect(
        handle.openLoginPtySession({
          driverKey: "daytona",
          companyId: "company-1",
          environmentId: "env-1",
          providerLeaseId: JSON.stringify({ mode: "normal" }),
          loginCommandKey: "claude" as const,
          sessionHome: "/tmp/paperclip-adapter-login/../etc",
        }),
      ).rejects.toThrow("LOGIN_PTY_INVALID_SESSION_HOME");
      // The rejected open never consumed the single route.
      const session = await handle.openLoginPtySession(
        ptyOpenInput({ mode: "normal" }),
      );
      expect(session).toBeDefined();
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("permits one active credential pseudo-terminal per worker", async () => {
    const handle = makeLoginPtyHandle();
    try {
      await handle.start();
      const first = await handle.openLoginPtySession(
        ptyOpenInput({ mode: "normal" }),
      );
      // A second open while the first route is not closed rejects with one fixed
      // non-secret error before it reaches the worker.
      await expect(
        handle.openLoginPtySession(ptyOpenInput({ mode: "normal" })),
      ).rejects.toThrow("LOGIN_PTY_ROUTE_BUSY");
      await first.close();
      // After the first route closes and the worker acknowledges the close, a new
      // open is admitted.
      const second = await handle.openLoginPtySession(
        ptyOpenInput({ mode: "normal" }),
      );
      await second.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("delivers output only for the exact bound worker session id and drops a mismatch", async () => {
    const handle = makeLoginPtyHandle();
    try {
      await handle.start();
      const session = await handle.openLoginPtySession(
        ptyOpenInput({
          workerSessionId: "ws-A",
          outputs: [
            { chunk: "good-1" },
            { chunk: "forged", sid: "ws-EVIL" },
            { chunk: "good-2" },
          ],
          exitCode: 0,
        }),
      );
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      await expect(session.wait()).resolves.toEqual({ exitCode: 0 });
      // The forged notification carries a wrong worker session id, so the host
      // drops it. Only the two bound chunks reach the listener, in order.
      expect(chunks).toEqual(["good-1", "good-2"]);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("routes delayed input to the worker and back to the listener", async () => {
    const handle = makeLoginPtyHandle();
    try {
      await handle.start();
      const session = await handle.openLoginPtySession(
        ptyOpenInput({ workerSessionId: "ws-A" }),
      );
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      session.write("browser-code");
      // The worker echoes the input as one output notification for the bound
      // session, so the listener receives it.
      await vi.waitFor(() => expect(chunks).toContain("echo:browser-code"));
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("terminalizes the route when the cumulative output passes the per-route bound", async () => {
    const handle = makeLoginPtyHandle({
      loginPtyLimits: { maxTotalChars: 10 },
    });
    try {
      await handle.start();
      const session = await handle.openLoginPtySession(
        ptyOpenInput({
          outputs: [
            { chunk: "aaaaa" }, // total 5 → delivered
            { chunk: "bbbbb" }, // total 10 → delivered
            { chunk: "ccccc" }, // total 15 > 10 → terminalize
          ],
        }),
      );
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      // The per-route bound terminalizes the route, so the login wait resolves
      // with a null exit code and the third chunk never reaches the listener.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      expect(chunks).toEqual(["aaaaa", "bbbbb"]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("terminalizes and fails closed on a malformed open reply, then admits a later open", async () => {
    const handle = makeLoginPtyHandle();
    try {
      await handle.start();
      await expect(
        handle.openLoginPtySession(ptyOpenInput({ mode: "malformed-open" })),
      ).rejects.toThrow("LOGIN_PTY_OPEN_FAILED");
      // The terminalize closed the route by the host route id and the worker
      // acknowledged the close, so a later open is admitted.
      const session = await handle.openLoginPtySession(
        ptyOpenInput({ mode: "normal" }),
      );
      expect(session).toBeDefined();
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("terminalizes the route on an open timeout", async () => {
    const handle = makeLoginPtyHandle({
      loginPtyLimits: { openTimeoutMs: 200 },
    });
    try {
      await handle.start();
      await expect(
        handle.openLoginPtySession(ptyOpenInput({ mode: "no-open-reply" })),
      ).rejects.toThrow();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("binds the worker session id one time and ignores a duplicate open reply", async () => {
    const handle = makeLoginPtyHandle();
    try {
      await handle.start();
      const session = await handle.openLoginPtySession(
        ptyOpenInput({
          mode: "duplicate-open-reply",
          workerSessionId: "ws-A",
          outputs: [{ chunk: "hello" }],
          exitCode: 0,
        }),
      );
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      // The duplicate open reply never rebinds or reopens the route, so the
      // session runs normally on the one bind.
      await expect(session.wait()).resolves.toEqual({ exitCode: 0 });
      expect(chunks).toEqual(["hello"]);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("closes the route with a fixed exit when the worker exits", async () => {
    const handle = makeLoginPtyHandle();
    try {
      await handle.start();
      const session = await handle.openLoginPtySession(
        ptyOpenInput({ mode: "normal" }),
      );
      const waitResult = session.wait();
      await handle.stop();
      // A worker exit closes the one route and resolves the login wait with the
      // fixed non-secret exit.
      await expect(waitResult).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("retires the worker on an unconfirmed close acknowledgement", async () => {
    const handle = makeLoginPtyHandle({
      loginPtyLimits: { closeTimeoutMs: 200 },
    });
    try {
      await handle.start();
      const exited = new Promise<void>((resolve) => {
        handle.on("exit", () => resolve());
      });
      const session = await handle.openLoginPtySession(
        ptyOpenInput({ mode: "normal", closeMode: "bad-ack" }),
      );
      await session.close();
      // The close acknowledgement carried a mismatched host route id, so the host
      // fails closed and retires the worker before any reuse.
      await exited;
      await expect(
        handle.openLoginPtySession(ptyOpenInput({ mode: "normal" })),
      ).rejects.toThrow();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
