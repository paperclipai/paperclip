/**
 * TECH-7895: the environment test reads the host Hermes config only when a run would, and never
 * launches an unbound Router launcher. Every child-process seam is a spy that fails closed, so no
 * Hermes (or Python) process is ever started here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const failClosed = () =>
    vi.fn((...args: unknown[]) => {
      const last = args[args.length - 1];
      if (typeof last === "function") {
        const err = new Error("spawn-blocked-ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        queueMicrotask(() => last(err));
      }
      return undefined as never;
    });
  return { ...actual, execFile: failClosed(), spawn: failClosed() };
});

vi.mock("./detect-model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./detect-model.js")>();
  return { ...actual, detectModel: vi.fn(async () => null) };
});

const routerProbe = vi.hoisted(() => vi.fn(async () => ({ supported: true as const })));
vi.mock("./router-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./router-readiness.js")>()),
  probeHermesRouterSupport: routerProbe,
}));

import { execFile, spawn } from "node:child_process";
import { detectModel } from "./detect-model.js";
import { ROUTER_EMPTY_PATH_MESSAGE } from "./router-readiness.js";
import { testEnvironment } from "./test.js";

const run = (config: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
  testEnvironment({
    companyId: "company-1",
    adapterType: "hermes_local",
    config: { hermesCommand: "/opt/x/hermes", ...config },
    ...ctx,
  });

const saved = { HOME: process.env.HOME, ISO: process.env.PAPERCLIP_HERMES_HOST_ISOLATION };
let home: string;

beforeEach(() => {
  vi.clearAllMocks();
  home = mkdtempSync(path.join(os.tmpdir(), "hermes-testenv-binding-"));
  process.env.HOME = home;
  delete process.env.PAPERCLIP_HERMES_HOST_ISOLATION;
});

afterEach(() => {
  process.env.HOME = saved.HOME;
  if (saved.ISO === undefined) delete process.env.PAPERCLIP_HERMES_HOST_ISOLATION;
  else process.env.PAPERCLIP_HERMES_HOST_ISOLATION = saved.ISO;
  rmSync(home, { recursive: true, force: true });
});

describe("host Hermes config discovery follows the run's predicate", () => {
  it("never reads the host config when host isolation is on", async () => {
    process.env.PAPERCLIP_HERMES_HOST_ISOLATION = "true";
    for (const config of [{}, { provider: "auto" }, { model: "auto-jev-routing" }, { provider: "router" }]) {
      await run(config);
    }
    expect(detectModel).not.toHaveBeenCalled();
  });

  it("skips discovery for an explicit non-auto provider with a model, including an unsupported one", async () => {
    await run({ provider: "anthropic", model: "claude-sonnet-5" });
    await run({ provider: "custom", model: "oca/gpt-5.4" });
    expect(detectModel).not.toHaveBeenCalled();
  });

  it("discovers locally whenever the run would: no provider, explicit auto, or no model", async () => {
    for (const config of [{ model: "x" }, { provider: "auto", model: "x" }, { provider: "anthropic" }]) {
      vi.mocked(detectModel).mockClear();
      await run(config);
      expect(detectModel, JSON.stringify(config)).toHaveBeenCalledTimes(1);
    }
  });
});

describe("Router binding failure", () => {
  it("fails readiness without launching any Hermes subprocess or probing", async () => {
    for (const env of [
      { RAMP_ROUTER_API_KEY: "router-test-key-7895", PATH: "" },
      { RAMP_ROUTER_API_KEY: "router-test-key-7895", PATH: "/usr/bin:/bin" },
    ]) {
      vi.clearAllMocks();
      const result = await run({ hermesCommand: env.PATH ? "no-such-hermes-7895" : "/opt/x/hermes", provider: "router", model: "auto-jev-routing", env });
      expect(result.status).toBe("fail");
      const codes = result.checks.map((check) => check.code);
      expect(codes).toContain("hermes_router_error");
      // Diagnostics that need no subprocess are still reported.
      expect(codes).toContain("hermes_model_configured");
      expect(codes).toContain("hermes_router_key_found");
      expect(codes).not.toContain("hermes_cli_not_found");
      expect(execFile).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(routerProbe).not.toHaveBeenCalled();
    }
    const empty = await run({ provider: "router", model: "auto-jev-routing", env: { RAMP_ROUTER_API_KEY: "k-7895", PATH: "" } });
    expect(empty.checks.find((check) => check.code === "hermes_router_error")?.message).toBe(ROUTER_EMPTY_PATH_MESSAGE);
  });
});

describe("Router remote target", () => {
  const sshTarget = {
    kind: "remote",
    transport: "ssh",
    remoteCwd: "/home/agent/workspace",
    spec: {
      host: "ssh.example.test",
      port: 22,
      username: "agent",
      remoteCwd: "/home/agent/workspace",
      remoteWorkspacePath: "/home/agent/workspace",
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: true,
    },
  };
  // TECH-8174: a sandbox target now verifies Router readiness inside the target (test-sandbox.ts);
  // only SSH keeps the up-front refusal.
  const targets = [["ssh", sshTarget]] as const;

  it("never launches anything on the host for a Router config on a sandbox target (TECH-8174)", async () => {
    const result = await run(
      { hermesCommand: "no-such-hermes-7895", provider: "router", model: "auto-jev-routing", env: { RAMP_ROUTER_API_KEY: "router-test-key-7895" } },
      { executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", providerKey: "kubernetes" } as never },
    );
    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toContain("hermes_untrusted_launcher");
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(routerProbe).not.toHaveBeenCalled();
  });

  it.each(targets)("rejects a Router config on a remote %s target before any CLI or Python subprocess", async (_label, executionTarget) => {
    // A command that exists nowhere: if the preliminary checks ran, the inherited-host-env spawn would
    // be observable. Nothing may launch, and the local diagnostics must not be reported as readiness.
    const result = await run(
      { hermesCommand: "no-such-hermes-7895", provider: "router", model: "auto-jev-routing", env: { RAMP_ROUTER_API_KEY: "router-test-key-7895" } },
      { executionTarget: executionTarget as never },
    );
    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toEqual(["hermes_router_remote_unsupported"]);
    expect(result.checks[0]?.message).toMatch(/only supported for Hermes Local runs/);
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(routerProbe).not.toHaveBeenCalled();
  });
});
