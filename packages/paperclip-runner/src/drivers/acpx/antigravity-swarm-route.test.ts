import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openQualifiedAcpxRuntime } from "./acpx-runtime-adapter.js";
import { antigravityRouteChangeRefusal, antigravitySwarmArguments, antigravitySwarmLaunchEnvironment, antigravitySwarmRouteRefusal, isAntigravitySwarmRoute } from "./antigravity-swarm-route.js";
import { createAcpxModeBinding, resolveAcpxProviderMode } from "./provider-mode.js";
import type { AcpxRuntimePortOpenOptions } from "./runtime-host.js";

const FIXTURE = new URL("../../../test-fixtures/antigravity-cli/fake-agy-acp.mjs", import.meta.url).pathname;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Antigravity swarm route selection", () => {
  it("is reachable only through the trusted swarm provider mode; every other turn keeps the registry server", () => {
    expect(resolveAcpxProviderMode("antigravity", undefined)).toBeUndefined();
    expect(createAcpxModeBinding("antigravity", undefined)).toBeNull();
    expect(resolveAcpxProviderMode("antigravity", "swarm")).toBe("swarm");
    expect(() => resolveAcpxProviderMode("antigravity", "auto")).toThrow(/only the swarm/);
    expect(() => resolveAcpxProviderMode("claude", "swarm")).toThrow();
    expect(isAntigravitySwarmRoute("antigravity", "swarm")).toBe(true);
    expect(isAntigravitySwarmRoute("antigravity", undefined)).toBe(false);
    expect(isAntigravitySwarmRoute("cursor", "swarm")).toBe(false);
  });

  it("says in plain language why a swarm cannot run here", () => {
    const signIn = { PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: "x" };
    expect(antigravitySwarmRouteRefusal({ environment: signIn, platform: "darwin", architecture: "arm64" })).toBeNull();
    expect(antigravitySwarmRouteRefusal({ environment: signIn, platform: "win32", architecture: "x64" })?.message).toMatch(/not available on this computer/);
    expect(antigravitySwarmRouteRefusal({ environment: { GEMINI_API_KEY: "k" }, platform: "darwin", architecture: "arm64" }))
      .toMatchObject({ code: "ANTIGRAVITY_SWARM_UNAVAILABLE", message: expect.stringMatching(/Gemini API key/) });
  });

  it("launches with private CLI state, the stable endpoint, self-update off and no registry credentials", () => {
    expect(antigravitySwarmArguments("/home/run/antigravity-cli")).toEqual([
      "--gemini-dir", "/home/run/antigravity-cli", "--cloud_code_endpoint", "https://cloudcode-pa.googleapis.com", "--disable-telemetry",
    ]);
    const environment = antigravitySwarmLaunchEnvironment(
      { HOME: "/private/home", GEMINI_HOME: "/private", AGY_ACP_FORCE_FILE_STORAGE: "1", PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: "s", GEMINI_API_KEY: "k", PATH: "/usr/bin" },
      { agentHomeDirectory: "/private", platform: "linux" });
    expect(environment).toEqual({ HOME: "/private/home", PATH: "/usr/bin", AGY_CLI_DISABLE_AUTO_UPDATE: "1" });
    expect(antigravitySwarmLaunchEnvironment({ HOME: "/private/home" }, { agentHomeDirectory: "/private", platform: "darwin", realHome: "/Users/owner" }).HOME).toBe("/Users/owner");
  });

  it("lets the server open a fresh conversation when a saved one belongs to the other route", () => {
    expect(antigravityRouteChangeRefusal("antigravity", "swarm", undefined)).toMatchObject({ code: "ANTIGRAVITY_SAVED_STATE_INCOMPATIBLE" });
    expect(antigravityRouteChangeRefusal("antigravity", undefined, "swarm")).toMatchObject({ code: "ANTIGRAVITY_SAVED_STATE_INCOMPATIBLE" });
    expect(antigravityRouteChangeRefusal("antigravity", undefined, undefined)).toBeNull();
    expect(antigravityRouteChangeRefusal("cursor", "plan", undefined)).toBeNull();
  });

  it("routes a swarm turn to the CLI runtime instead of ACPX", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agy-route-")));
    roots.push(root);
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    const runtime = await openQualifiedAcpxRuntime({
      command: { spawn: () => spawn(process.execPath, [FIXTURE], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, FAKE_AGY_SCENARIO: "success" } }), close: async () => {} },
      profile: { agent: "antigravity", reportedModelId: "gemini-3.8-flash-low", qualificationModel: "gemini-3.8-flash-low" },
      cwd, stateDirectory: root, providerSessionKey: "key", permissionMode: "approve-reads", mode: "swarm",
      permissionPolicy: {}, launchEnvironment: {}, credentialFenceFds: null, activateCredentialFenceOwner: null, systemInstructions: "x",
      mcpServers: [{ name: "paperclip", url: "http://127.0.0.1:9/mcp", bearerToken: "t", runnerOwned: true }], retainFailedAdmissionCleanup: () => {},
    } as unknown as AcpxRuntimePortOpenOptions);
    expect(await runtime.identity()).toMatchObject({ mode: "swarm" });
    await runtime.close({ reason: "done" });
  });
});
