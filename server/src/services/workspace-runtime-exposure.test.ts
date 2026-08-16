import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BrokerClient, BrokerListenerRequest } from "./runtime-exposure/broker-client.js";
import {
  resetRuntimeServicesForTests,
  setWorkspaceRuntimeExposureDepsForTests,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
} from "./workspace-runtime.js";

const EXECUTION_WORKSPACE_ID = "11111111-2222-4333-8444-555566667777";
const HANDLE = "handle-abcdef1234567890";

// The shared test setup pins the automatic default off so unrelated suites do
// not probe for a real host broker. This suite is about the default, so it opts
// back in and restores the harness value afterwards.
let previousHttpsMode: string | undefined;
beforeEach(() => {
  previousHttpsMode = process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS;
  process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS = "auto";
});

afterEach(async () => {
  if (previousHttpsMode === undefined) delete process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS;
  else process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS = previousHttpsMode;
  // These tests spawn real loopback backends on dedicated-range ports; reap them
  // rather than leaving one squatting 42xxx/52xxx for every test in the file.
  await resetRuntimeServicesForTests({ terminateProcesses: true });
});

function serviceCommand() {
  return `node -e 'const http=require("http");const p=Number(process.env.PORT);for(const q of [p,p+10000])http.createServer((_,r)=>{r.statusCode=200;r.end("ok")}).listen(q,"127.0.0.1");setInterval(()=>{},1000)'`;
}

function createBroker() {
  const calls: string[] = [];
  let listeners: BrokerListenerRequest[] = [];
  const broker: BrokerClient = {
    async reserve(_runtimeId, requested) {
      calls.push("reserve");
      listeners = requested;
      return { handle: HANDLE, reservedPorts: requested.map((listener) => listener.port) };
    },
    async expose() {
      calls.push("expose");
      return { handle: HANDLE, publicPorts: listeners.map((listener) => listener.port) };
    },
    async remove() {
      calls.push("remove");
      return { removedPorts: listeners.map((listener) => listener.port) };
    },
    async list() {
      return [];
    },
  };
  return { broker, calls };
}

function installDeps(overrides: {
  broker: BrokerClient;
  probeHealth?: () => Promise<boolean>;
  isBrokerAvailable?: () => Promise<boolean>;
  isPortAvailable?: (port: number) => Promise<boolean>;
}) {
  setWorkspaceRuntimeExposureDepsForTests({
    broker: overrides.broker,
    isPortAvailable: overrides.isPortAvailable ?? (async () => true),
    isBrokerAvailable: overrides.isBrokerAvailable ?? (async () => true),
    resolveHostname: async () => "runner.tail123.ts.net",
    probeHealth: overrides.probeHealth ?? (async () => true),
    now: () => "2026-08-11T00:00:00.000Z",
  });
}

const DECLARED_EXPOSE = {
  type: "tailscale_https",
  hostname: "auto",
  publicPort: "same",
  includePaperclipViteHmr: true,
  failurePolicy: "fail_closed",
} as const;

/**
 * The pre-feature Paperclip App project template, verbatim: a hard-coded HTTP
 * `urlTemplate`, a pinned port outside the broker's dedicated range, and no
 * exposure declaration at all.
 */
const LEGACY_HTTP_EXPOSE = {
  type: "url",
  urlTemplate: "http://paperclip-dev:{{port}}",
} as const;

function startInput(options?: {
  serviceName?: string;
  expose?: Record<string, unknown> | null;
  port?: Record<string, unknown> | number;
}) {
  const expose = options?.expose === undefined ? DECLARED_EXPOSE : options.expose;
  return {
    invocationId: "runtime-exposure-test",
    actor: { id: null, name: "Paperclip", companyId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    issue: null,
    workspace: {
      baseCwd: process.cwd(),
      source: "project_primary" as const,
      projectId: null,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      strategy: "project_primary" as const,
      cwd: process.cwd(),
      branchName: "test",
      worktreePath: null,
      warnings: [],
      created: false,
    },
    executionWorkspaceId: EXECUTION_WORKSPACE_ID,
    config: {
      workspaceRuntime: {
        services: [{
          name: options?.serviceName ?? "preview",
          command: serviceCommand(),
          port: options?.port ?? { type: "auto", envKey: "PORT" },
          readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 5 },
          ...(expose ? { expose } : {}),
        }],
      },
    },
    adapterEnv: {},
  };
}

describe("workspace runtime tailscale_https lifecycle", () => {
  it("reserves before spawn, exposes after backend readiness, and removes on stop", async () => {
    const { broker, calls } = createBroker();
    installDeps({ broker });

    const [runtime] = await startRuntimeServicesForWorkspaceControl(startInput());
    expect(calls.slice(0, 2)).toEqual(["reserve", "expose"]);
    expect(runtime.port).toBeGreaterThanOrEqual(42000);
    expect(runtime.url).toBe(`https://runner.tail123.ts.net:${runtime.port}`);
    expect(runtime.exposure?.state).toBe("ready");

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: EXECUTION_WORKSPACE_ID,
      runtimeServiceId: runtime.id,
    });
    expect(calls).toEqual(["reserve", "expose", "remove"]);
  }, 15_000);

  it("fails closed and removes the mapping when external HTTPS validation fails", async () => {
    const { broker, calls } = createBroker();
    installDeps({ broker, probeHealth: async () => false });

    await expect(startRuntimeServicesForWorkspaceControl(startInput())).rejects.toThrow(/HTTPS exposure failed/);
    expect(calls).toEqual(["reserve", "expose", "remove"]);
  }, 15_000);
});

describe("automatic tailscale_https default for managed worktree runtimes", () => {
  it("defaults a legacy paperclip-dev service with no exposure block, relocating its pinned port", async () => {
    const { broker, calls } = createBroker();
    installDeps({ broker });

    // Exactly the persisted pre-feature shape: pinned 45439 + HTTP urlTemplate.
    const [runtime] = await startRuntimeServicesForWorkspaceControl(startInput({
      serviceName: "paperclip-dev",
      expose: LEGACY_HTTP_EXPOSE,
      port: 45_439,
    }));

    expect(calls.slice(0, 2)).toEqual(["reserve", "expose"]);
    // 45439 is outside the broker allowlist, so the pinned port cannot be kept.
    expect(runtime.port).not.toBe(45_439);
    expect(runtime.port).toBeGreaterThanOrEqual(42_000);
    expect(runtime.port).toBeLessThanOrEqual(42_999);
    // The canonical URL is the verified HTTPS origin; HTTP is never retained.
    expect(runtime.url).toBe(`https://runner.tail123.ts.net:${runtime.port}`);
    expect(runtime.url).not.toContain("http://");
    expect(runtime.exposure?.state).toBe("ready");
  }, 15_000);

  it("keeps an existing runtime port that is already inside the dedicated range", async () => {
    const { broker } = createBroker();
    installDeps({ broker });

    const [runtime] = await startRuntimeServicesForWorkspaceControl(startInput({
      serviceName: "paperclip-dev",
      expose: LEGACY_HTTP_EXPOSE,
      port: 42_500,
    }));

    expect(runtime.port).toBe(42_500);
    expect(runtime.url).toBe("https://runner.tail123.ts.net:42500");
  }, 15_000);

  it("preserves a deliberate opt-out and leaves the service on plain HTTP", async () => {
    const { broker, calls } = createBroker();
    installDeps({ broker });

    const [runtime] = await startRuntimeServicesForWorkspaceControl(startInput({
      serviceName: "paperclip-dev",
      expose: { ...LEGACY_HTTP_EXPOSE, tailscaleHttps: false },
      port: { type: "auto", envKey: "PORT" },
    }));

    expect(calls).toEqual([]);
    expect(runtime.exposure ?? null).toBeNull();
    expect(runtime.url).toBe(`http://paperclip-dev:${runtime.port}`);
  }, 15_000);

  it("leaves an unmanaged/custom service untouched", async () => {
    const { broker, calls } = createBroker();
    installDeps({ broker });

    const [runtime] = await startRuntimeServicesForWorkspaceControl(startInput({
      serviceName: "preview",
      expose: LEGACY_HTTP_EXPOSE,
      port: { type: "auto", envKey: "PORT" },
    }));

    expect(calls).toEqual([]);
    expect(runtime.exposure ?? null).toBeNull();
    expect(runtime.url).toBe(`http://paperclip-dev:${runtime.port}`);
  }, 15_000);

  it("does not default when the host broker is unavailable", async () => {
    const { broker, calls } = createBroker();
    installDeps({ broker, isBrokerAvailable: async () => false });

    const [runtime] = await startRuntimeServicesForWorkspaceControl(startInput({
      serviceName: "paperclip-dev",
      expose: LEGACY_HTTP_EXPOSE,
      port: { type: "auto", envKey: "PORT" },
    }));

    expect(calls).toEqual([]);
    expect(runtime.exposure ?? null).toBeNull();
  }, 15_000);

  it("still honors an explicit opt-in when the broker socket is missing, failing loudly", async () => {
    // A missing broker must never silently downgrade a requested HTTPS preview.
    const { broker, calls } = createBroker();
    const failing: BrokerClient = {
      ...broker,
      async reserve() {
        calls.push("reserve");
        throw new Error("ENOENT: broker socket missing");
      },
    };
    installDeps({ broker: failing, isBrokerAvailable: async () => false });

    await expect(
      startRuntimeServicesForWorkspaceControl(startInput({ serviceName: "paperclip-dev" })),
    ).rejects.toThrow();
    expect(calls).toEqual(["reserve"]);
  }, 15_000);

  it("is idempotent across repeated starts: the same port pair is reserved again", async () => {
    const { broker, calls } = createBroker();
    installDeps({ broker });

    const [first] = await startRuntimeServicesForWorkspaceControl(startInput({
      serviceName: "paperclip-dev",
      expose: LEGACY_HTTP_EXPOSE,
      port: 45_439,
    }));
    const firstPort = first.port;
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: EXECUTION_WORKSPACE_ID,
      runtimeServiceId: first.id,
    });
    calls.length = 0;

    const [second] = await startRuntimeServicesForWorkspaceControl(startInput({
      serviceName: "paperclip-dev",
      expose: LEGACY_HTTP_EXPOSE,
      port: 45_439,
    }));

    expect(calls.slice(0, 2)).toEqual(["reserve", "expose"]);
    expect(second.port).toBe(firstPort);
    expect(second.url).toBe(`https://runner.tail123.ts.net:${firstPort}`);
  }, 25_000);
});
