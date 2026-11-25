import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";

const mocks = vi.hoisted(() => ({
  released: false,
  probe: vi.fn(),
  createOwner: vi.fn(),
}));

vi.mock("../../vendor/paperclip-runner/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>();
  const pending = { ...original.QUALIFIED_ACPX_PROFILES.antigravity, qualificationStatus: "pending" as const };
  const profiles = { ...original.QUALIFIED_ACPX_PROFILES };
  Object.defineProperty(profiles, "antigravity", {
    enumerable: true,
    get: () => mocks.released ? original.QUALIFIED_ACPX_PROFILES.antigravity : pending,
  });
  return {
    ...original,
    QUALIFIED_ACPX_PROFILES: profiles,
    probeNativeRunnerEnvironment: mocks.probe,
  };
});

vi.mock("./plugin-runner-task.js", async importOriginal => {
  const original = await importOriginal<typeof import("./plugin-runner-task.js")>();
  return {
    ...original,
    createPluginRunnerTaskOwner: (input: Parameters<typeof original.createPluginRunnerTaskOwner>[0]) => {
      mocks.createOwner(input);
      return { driver: { prepareLaunch: vi.fn() } };
    },
  };
});

import { probePluginRunnerEnvironment } from "./plugin-runner-probe.js";
import { resolvePaperclipRunnerProviderProfile } from "./provider-profile.js";

const SIGN_IN_ENV = "PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET";
const signInJson = JSON.stringify({
  client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  client_secret: "fixture-client-secret",
  refresh_token: "fixture-refresh-token",
  token_uri: "https://oauth2.googleapis.com/token",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/aicode",
  ],
});

describe("plugin Runner probe for Google Antigravity", () => {
  const roots: string[] = [];
  const runnerTask = vi.fn();

  function buildContext(env: Record<string, string> = {}): AdapterEnvironmentTestContext {
    return {
      companyId: "company-1",
      adapterType: "paperclip_runner",
      config: { provider: "acpx", acpxAgent: "antigravity", model: "gemini-3.8-flash-high", env },
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        remoteCwd: ".",
        leaseId: "probe-lease",
        runnerTaskProbe: { runId: "probe-run", sessionId: "probe-session" },
        runnerTask,
      },
    } as unknown as AdapterEnvironmentTestContext;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.released = false;
    runnerTask.mockResolvedValue({
      kind: "description",
      launchPreparationVersion: 1,
      projectAuthCheckVersion: 1,
      taskId: "probe-task",
      runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` },
    });
    mocks.probe.mockImplementation(async input => {
      await input.onCleanupConfirmed?.();
      return {
        provider: "acpx",
        providerDriver: "acpx_runtime",
        effectiveModel: "gemini-3.8-flash-high",
        admissionOnly: true,
        sessionAdmissionPassed: true,
        helloProbePassed: false,
      };
    });
  });

  afterEach(async () => {
    mocks.released = false;
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it("refuses plugin Runner-task probing while Antigravity is pending", async () => {
    const result = await probePluginRunnerEnvironment(buildContext({ GEMINI_API_KEY: "fixture-gemini-key" }), {
      identity: "key-id",
      accountIdentity: "key-session",
    });
    expect(result).toMatchObject({
      status: "fail",
      checks: [{ code: "antigravity_remote_unavailable", level: "error" }],
    });
    expect(runnerTask).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it("probes a released Antigravity agent with a Gemini API key through the plugin Runner", async () => {
    mocks.released = true;
    const result = await probePluginRunnerEnvironment(buildContext({ GEMINI_API_KEY: "fixture-gemini-key" }), {
      identity: "key-id",
      accountIdentity: "key-session",
    });
    expect(result).toMatchObject({
      status: "pass",
      checks: [{ code: "antigravity_metadata_verified", level: "info" }],
    });
    expect(mocks.createOwner).toHaveBeenCalledWith(expect.objectContaining({
      harness: "antigravity",
      credentialIdentity: "key-id",
      accountIdentity: "key-session",
      credential: { type: "provider-env", provider: "antigravity", environment: { GEMINI_API_KEY: "fixture-gemini-key" } },
    }));
    expect(mocks.probe).toHaveBeenCalledWith(expect.objectContaining({
      provider: "acpx",
      model: "gemini-3.8-flash-high",
      admissionOnly: true,
      transportOptions: expect.objectContaining({
        acpxAgent: "antigravity",
        acpxPermissionMode: "deny-all",
        acpxPermissionModePinned: true,
      }),
    }));
  });

  it("probes a released Antigravity agent with a Google sign-in through the plugin Runner", async () => {
    mocks.released = true;
    const managedHome = await realpath(await mkdtemp(join(tmpdir(), "antigravity-plugin-probe-")));
    roots.push(managedHome);
    await mkdir(join(managedHome, "antigravity-acp"), { mode: 0o700 });
    await writeFile(join(managedHome, "antigravity-acp", "acp_token.json"), signInJson, { mode: 0o600 });

    const result = await probePluginRunnerEnvironment(buildContext({}), {
      identity: "google-id",
      accountIdentity: "google-session",
      home: managedHome,
    });
    expect(result).toMatchObject({
      status: "pass",
      checks: [{ code: "antigravity_metadata_verified", level: "info" }],
    });
    expect(mocks.createOwner).toHaveBeenCalledWith(expect.objectContaining({
      harness: "antigravity",
      credentialIdentity: "google-id",
      accountIdentity: "google-session",
      needsWriteback: true,
      credential: {
        type: "provider-env",
        provider: "antigravity",
        environment: { [SIGN_IN_ENV]: signInJson },
      },
    }));
    expect(mocks.probe).toHaveBeenCalledWith(expect.objectContaining({
      provider: "acpx",
      model: "gemini-3.8-flash-high",
      admissionOnly: true,
    }));
  });

  it("fails when the plugin Runner returns a mismatched Antigravity admission receipt", async () => {
    mocks.released = true;
    mocks.probe.mockImplementationOnce(async input => {
      await input.onCleanupConfirmed?.();
      return {
        provider: "acpx",
        providerDriver: "acpx_runtime",
        effectiveModel: "wrong-model",
        admissionOnly: true,
        sessionAdmissionPassed: true,
        helloProbePassed: false,
      };
    });
    const result = await probePluginRunnerEnvironment(buildContext({ GEMINI_API_KEY: "fixture-gemini-key" }), {
      identity: "key-id",
      accountIdentity: "key-session",
    });
    expect(result).toMatchObject({ status: "fail", checks: [{ code: "runner_hello_probe_failed", level: "error" }] });
  });

  it("requires a managed AI connection for Antigravity on a plugin Runner-task environment", async () => {
    mocks.released = true;
    const result = await probePluginRunnerEnvironment(buildContext({}));
    expect(result).toMatchObject({
      status: "fail",
      checks: [{ code: "runner_account_selection_required", level: "error" }],
    });
    expect(runnerTask).not.toHaveBeenCalled();
  });

  it("resolves released Antigravity profiles only with an explicit non-placeholder model", () => {
    mocks.released = true;
    expect(resolvePaperclipRunnerProviderProfile({ provider: "acpx", acpxAgent: "antigravity", model: "gemini-3.8-flash-high" }))
      .toEqual({ provider: "acpx", backend: "acpx_runtime", model: "gemini-3.8-flash-high", acpxAgent: "antigravity" });
    for (const model of ["", "auto", "default"]) {
      expect(() => resolvePaperclipRunnerProviderProfile({ provider: "acpx", acpxAgent: "antigravity", model }))
        .toThrow("explicit model ID");
    }
  });
});
