import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BrokerClient, BrokerListenerRequest } from "./runtime-exposure/broker-client.js";
import { diagnoseRuntimeListenerBinds } from "./runtime-exposure/loopback-listener.js";
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

/**
 * Fake guest dev runners written to disk (PAP-17256).
 *
 * They must be real files named `dev-runner*.mjs` for two reasons: the command
 * has to look like a dev-runner invocation for the rewrite to apply at all, and
 * `node <file> --bind lan` hands the flags to the script, which is exactly how a
 * real `pnpm dev --bind lan` reaches `scripts/dev-runner.ts`.
 */
let guestDir: string;

/**
 * A guest checkout from *before* managed HTTPS exposure existed.
 *
 * Reproduces the behaviour that actually broke the lanes: `scripts/dev-runner.ts`
 * on plain master derives its bind mode from its own `--bind` / `--bind-host`
 * argv and **ignores `PAPERCLIP_BIND` / `PAPERCLIP_MANAGED_RUNTIME_EXPOSURE`
 * entirely** — so env-only hardening cannot reach it. `--bind lan` therefore
 * means `0.0.0.0`, which the broker must refuse.
 */
const PRE_MANAGED_EXPOSURE_GUEST = `
import http from "node:http";
const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const at = argv.indexOf(flag);
  const value = at >= 0 ? argv[at + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
};
const mode = valueOf("--bind") ?? "loopback";
const host = mode === "custom" ? (valueOf("--bind-host") ?? "127.0.0.1")
  : mode === "lan" ? "0.0.0.0"
  : "127.0.0.1";
const p = Number(process.env.PORT);
for (const q of [p, p + 10000]) {
  http.createServer((_, r) => { r.statusCode = 200; r.end("ok"); }).listen(q, host);
}
setInterval(() => {}, 1000);
`;

/**
 * The true shape of the deployed failure: a guest that honours the bind argv for
 * its own HTTP listener but whose Vite gets `hmr.port` with no `hmr.server` and
 * no `server.host`, so Vite opens its *own* HMR websocket on the IPv6 wildcard
 * regardless of the bind mode. Plain master's `server/src/app.ts` does exactly
 * this, which is why forcing the bind is necessary but not sufficient there.
 */
const WILDCARD_HMR_GUEST = `
import http from "node:http";
const argv = process.argv.slice(2);
const at = argv.indexOf("--bind-host");
const host = at >= 0 ? argv[at + 1] : "127.0.0.1";
const p = Number(process.env.PORT);
http.createServer((_, r) => { r.statusCode = 200; r.end("ok"); }).listen(p, host);
// No host argument: Vite's own HMR listener lands on the wildcard.
http.createServer((_, r) => { r.statusCode = 426; r.end(); }).listen(p + 10000);
setInterval(() => {}, 1000);
`;

/** A guest so old it has no bind flags at all and always binds the wildcard. */
const ALWAYS_WILDCARD_GUEST = `
import http from "node:http";
const p = Number(process.env.PORT);
for (const q of [p, p + 10000]) {
  http.createServer((_, r) => { r.statusCode = 200; r.end("ok"); }).listen(q, "0.0.0.0");
}
setInterval(() => {}, 1000);
`;

beforeAll(async () => {
  guestDir = await fs.mkdtemp(path.join(os.tmpdir(), "pap-17256-guest-"));
  await fs.writeFile(path.join(guestDir, "dev-runner.mjs"), PRE_MANAGED_EXPOSURE_GUEST);
  await fs.writeFile(path.join(guestDir, "dev-runner-legacy.mjs"), ALWAYS_WILDCARD_GUEST);
  await fs.writeFile(path.join(guestDir, "dev-runner-wildcard-hmr.mjs"), WILDCARD_HMR_GUEST);
});

afterAll(async () => {
  await fs.rm(guestDir, { recursive: true, force: true });
});

const guestCommand = (file: string) => `node ${path.join(guestDir, file)}`;

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
  diagnoseListenerBinds?: (ports: number[]) => Promise<string | null>;
}) {
  setWorkspaceRuntimeExposureDepsForTests({
    broker: overrides.broker,
    isPortAvailable: overrides.isPortAvailable ?? (async () => true),
    isBrokerAvailable: overrides.isBrokerAvailable ?? (async () => true),
    resolveHostname: async () => "runner.tail123.ts.net",
    probeHealth: overrides.probeHealth ?? (async () => true),
    now: () => "2026-08-11T00:00:00.000Z",
    // The real /proc-backed diagnosis, not a fake: the fake broker below always
    // says yes, so this is what has to catch an off-loopback bind here.
    diagnoseListenerBinds: overrides.diagnoseListenerBinds ?? diagnoseRuntimeListenerBinds,
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
  command?: string;
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
          command: options?.command ?? serviceCommand(),
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

/**
 * PAP-17256: the deployed regression. A fresh managed lane on service index 0
 * failed every start with `listener_ownership_mismatch` because the branch
 * checkout it launched bound `0.0.0.0`, and the server only asked for loopback
 * via env vars that checkout never read.
 */
describe("loopback bind is forced on the guest, not merely requested (PAP-17256)", () => {
  it("starts a fresh service-index-0 lane whose guest only honours argv", async () => {
    const { broker, calls } = createBroker();
    installDeps({ broker });

    const [runtime] = await startRuntimeServicesForWorkspaceControl(startInput({
      serviceName: "paperclip-dev",
      // Verbatim the command every failing lane recorded, modulo the fake guest.
      command: `${guestCommand("dev-runner.mjs")} --bind lan`,
      expose: LEGACY_HTTP_EXPOSE,
      port: { type: "auto", envKey: "PORT" },
    }));

    // The launched command carries the loopback bind, replacing `--bind lan`.
    expect(runtime.command).toContain("--bind custom --bind-host 127.0.0.1");
    expect(runtime.command).not.toContain("--bind lan");

    // And because the guest honoured it, both listeners are loopback-only, so
    // the exposure completes instead of being denied.
    expect(calls.slice(0, 2)).toEqual(["reserve", "expose"]);
    expect(runtime.exposure?.state).toBe("ready");
    expect(runtime.exposure?.lastError ?? null).toBeNull();
    expect(runtime.port).toBeGreaterThanOrEqual(42_000);
    expect(runtime.url).toBe(`https://runner.tail123.ts.net:${runtime.port}`);

    // Independent confirmation on the live listeners, using the same /proc read
    // the broker's gate performs.
    const hmrPort = runtime.port! + 10_000;
    expect(await diagnoseRuntimeListenerBinds([runtime.port!, hmrPort])).toBeNull();

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: EXECUTION_WORKSPACE_ID,
      runtimeServiceId: runtime.id,
    });
    expect(calls).toEqual(["reserve", "expose", "remove"]);
  }, 20_000);

  it("reaches a terminal failure naming the port and address when a guest still binds the wildcard", async () => {
    const { broker, calls } = createBroker();
    installDeps({ broker });

    // A guest with no bind flags at all: the argv rewrite cannot reach it, so
    // this is the residual case that must fail loudly rather than expose.
    await expect(startRuntimeServicesForWorkspaceControl(startInput({
      serviceName: "paperclip-dev",
      command: guestCommand("dev-runner-legacy.mjs"),
      expose: LEGACY_HTTP_EXPOSE,
      port: { type: "auto", envKey: "PORT" },
    }))).rejects.toThrow(/listener_ownership_mismatch.*(?:0\.0\.0\.0|::)/s);

    // Terminal recovery: the reservation is released and nothing was exposed.
    // The diagnosis runs before the broker, so `expose` is never attempted.
    expect(calls).toEqual(["reserve", "remove"]);
  }, 20_000);

  it("explains rather than only coding the failure, so the next operator can act", async () => {
    const { broker } = createBroker();
    installDeps({ broker });

    const error = await startRuntimeServicesForWorkspaceControl(startInput({
      serviceName: "paperclip-dev",
      command: guestCommand("dev-runner-legacy.mjs"),
      expose: LEGACY_HTTP_EXPOSE,
      port: { type: "auto", envKey: "PORT" },
    })).then(() => null, (err: unknown) => err as Error);

    expect(error).not.toBeNull();
    // The bare code alone is what cost PAP-17254 three diagnostic cycles.
    expect(error!.message).toContain("listener_ownership_mismatch");
    expect(error!.message).toContain("loopback");
    expect(error!.message).toContain("--bind custom --bind-host 127.0.0.1");
  }, 20_000);

  it("leaves a non-Paperclip service's --bind argument alone", async () => {
    // `--bind` means something entirely different to the HTTPS probe canaries
    // (`python3 -m http.server --bind 127.0.0.1`); rewriting it would break them.
    const { broker, calls } = createBroker();
    installDeps({ broker });

    const declared = `${serviceCommand()} -- --bind 127.0.0.1`;
    const [runtime] = await startRuntimeServicesForWorkspaceControl(startInput({
      serviceName: "https-probe-canary",
      command: declared,
      port: { type: "auto", envKey: "PORT" },
    }));

    expect(runtime.command).toBe(declared);
    expect(runtime.command).not.toContain("--bind custom");
    expect(calls.slice(0, 2)).toEqual(["reserve", "expose"]);
    expect(runtime.exposure?.state).toBe("ready");
  }, 20_000);

  it("does not rewrite a Paperclip dev command when the service is not exposed", async () => {
    const { broker, calls } = createBroker();
    installDeps({ broker });

    const declared = `${guestCommand("dev-runner.mjs")} --bind lan`;
    const [runtime] = await startRuntimeServicesForWorkspaceControl(startInput({
      serviceName: "paperclip-dev",
      command: declared,
      expose: { ...LEGACY_HTTP_EXPOSE, tailscaleHttps: false },
      port: { type: "auto", envKey: "PORT" },
    }));

    expect(calls).toEqual([]);
    expect(runtime.command).toBe(declared);
  }, 20_000);
});

describe("readiness probes loopback for an exposed runtime (PAP-17256)", () => {
  it("starts even when the only readiness target is the MagicDNS display URL", async () => {
    // The live project config declares a loopback readiness URL, but when it does
    // not, readiness falls back to `expose.urlTemplate` — a MagicDNS name that
    // resolves off-loopback. That only ever answered because the guest was bound
    // to the wildcard, so it must be normalised alongside the bind fix.
    const { broker, calls } = createBroker();
    installDeps({ broker });

    const input = startInput({
      serviceName: "paperclip-dev",
      command: `${guestCommand("dev-runner.mjs")} --bind lan`,
      expose: LEGACY_HTTP_EXPOSE,
      port: { type: "auto", envKey: "PORT" },
    });
    // Drop the explicit loopback readiness URL so the fallback path is exercised.
    const service = input.config.workspaceRuntime.services[0] as Record<string, unknown>;
    service.readiness = { type: "http", timeoutSec: 10, intervalMs: 100 };

    const [runtime] = await startRuntimeServicesForWorkspaceControl(input);

    expect(calls.slice(0, 2)).toEqual(["reserve", "expose"]);
    expect(runtime.exposure?.state).toBe("ready");
    expect(runtime.url).toBe(`https://runner.tail123.ts.net:${runtime.port}`);
  }, 20_000);
});

describe("the deployed failure shape: loopback app port, wildcard HMR (PAP-17256)", () => {
  it("fails terminally naming the HMR port, because forcing the bind cannot reach Vite's own listener", async () => {
    // Plain master's app.ts passes Vite `hmr.port` without `hmr.server` or
    // `server.host`, so the HMR websocket binds `::` no matter what the bind mode
    // is. The argv rewrite fixes the app port; only the preflight catches this.
    const { broker, calls } = createBroker();
    installDeps({ broker });

    const error = await startRuntimeServicesForWorkspaceControl(startInput({
      serviceName: "paperclip-dev",
      command: `${guestCommand("dev-runner-wildcard-hmr.mjs")} --bind lan`,
      expose: LEGACY_HTTP_EXPOSE,
      port: { type: "auto", envKey: "PORT" },
    })).then(() => null, (err: unknown) => err as Error);

    expect(error).not.toBeNull();
    expect(error!.message).toContain("listener_ownership_mismatch");
    // The app port obeyed the forced bind; the HMR companion is the offender, and
    // the diagnosis has to say so rather than blaming the lane as a whole.
    expect(error!.message).toMatch(/port 5\d{4} is bound to/);
    expect(error!.message).not.toMatch(/port 4\d{4} is bound to/);
    expect(calls).toEqual(["reserve", "remove"]);
  }, 20_000);
});
