import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const release = vi.hoisted(() => ({ pending: false }));
const grant = vi.hoisted(() => ({ admitted: false, targets: [] as Array<{ platform: string; architecture: string } | undefined> }));
const backend = vi.hoisted(() => ({ options: undefined as undefined | { codexTransportFactory?: () => unknown } }));

vi.mock("../../vendor/paperclip-runner/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>();
  const pending = {
    ...original.QUALIFIED_ACPX_PROFILES.antigravity,
    agentProfileVersion: original.QUALIFIED_ACPX_PROFILES.antigravity.agentProfileVersion - 1,
    qualificationStatus: "pending" as const,
  };
  const profiles = { ...original.QUALIFIED_ACPX_PROFILES };
  Object.defineProperty(profiles, "antigravity", { enumerable: true,
    get: () => release.pending ? pending : original.QUALIFIED_ACPX_PROFILES.antigravity });
  return {
    ...original,
    QUALIFIED_ACPX_PROFILES: profiles,
    createNativeSessionBackend: vi.fn((_session: unknown, options: { codexTransportFactory?: () => unknown }) => {
      backend.options = options;
      return { kind: "test", openSession: vi.fn() };
    }),
    createRunnerdCodexTransport: vi.fn(() => ({ transport: { close: vi.fn(async () => undefined) } })),
    executeNativeSession: vi.fn(async () => { throw new Error("fixture: provider execution is out of scope"); }),
  };
});

vi.mock("./acpx-qualification.js", async importOriginal => {
  const original = await importOriginal<typeof import("./acpx-qualification.js")>();
  return {
    ...original,
    resolveAntigravityCandidateAdmission: vi.fn((input: Parameters<typeof original.resolveAntigravityCandidateAdmission>[0]) => {
      grant.targets.push(input.target);
      if (!grant.admitted || input.target?.platform !== "linux" || input.target.architecture !== "x64") return undefined;
      return { schema: "paperclip.acpx-candidate-admission.v1", companyId: input.companyId, agent: "antigravity", model: input.model,
        platform: "linux", architecture: "x64" };
    }),
  };
});

vi.mock("./native-runner-file-handoff.js", () => ({
  stageNativeRunnerWakeAttachments: vi.fn(async () => ({ attachments: [], cleanup: async () => undefined })),
  renderNativeRunnerStagedAttachmentPrompt: vi.fn(() => null),
}));

vi.mock("./native-controller-recovery.js", async importOriginal => ({
  ...await importOriginal<typeof import("./native-controller-recovery.js")>(),
  resolveNativeControllerRecovery: vi.fn(async () => ({ kind: "no_prior_execution" })),
}));

vi.mock("../../runtime-api.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../runtime-api.js")>(),
  resolveLocalRuntimeApiUrl: vi.fn(() => "http://127.0.0.1:43219"),
}));

import { NativeProviderStateIncompatibleError, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { antigravityReleasePending } from "./antigravity-release.js";
import { createRunnerdBackend, executePaperclipNativeSession } from "./native-session-executor.js";
import * as pluginTaskRuntime from "./plugin-runner-task.js";
import * as pluginCredentialWriteback from "../plugin-task-credential-writeback.js";
import { antigravityExecution, emptyDb } from "./antigravity.test-fixture.js";

const describeTask = vi.fn(async (operation: { kind: string }) => operation.kind === "describe"
  ? { kind: "description", launchPreparationVersion: 1, projectAuthCheckVersion: 1, taskId: "task",
      runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` } }
  : { kind: "accepted", taskId: "task" });
const pluginTarget = () => ({ kind: "remote", transport: "sandbox", providerKey: "plugin", leaseId: "lease",
  remoteCwd: "/unused", runnerTask: describeTask }) as unknown as AdapterExecutionTarget;
const sandboxTarget = () => ({ kind: "remote", transport: "sandbox", remoteCwd: "/workspace",
  runner: { execute: vi.fn() } }) as unknown as AdapterExecutionTarget;
const runStart = (execution: NativeExecutionInput, runnerExecutionTarget: AdapterExecutionTarget, db = emptyDb()) =>
  executePaperclipNativeSession({ db, execution, useRunnerd: true, runnerInstanceId: "antigravity-run-start",
    runnerIngressAuthorized: true, runnerExecutionTarget });
const INELIGIBLE = /paperclip_runner_antigravity_candidate_ineligible/;
const COORDINATOR_CLAIM = /^native_finalization_coordinator_missing$/;
const coordinatorReads = [{ table: "native_run_finalizations", locked: false }, { table: "native_run_finalizations", locked: true }];

let ownerFactory: MockInstance<typeof pluginTaskRuntime.createPluginRunnerTaskOwner>;
beforeEach(() => {
  grant.admitted = false; grant.targets = []; backend.options = undefined;
  describeTask.mockClear();
  ownerFactory = vi.spyOn(pluginTaskRuntime, "createPluginRunnerTaskOwner");
});
afterEach(() => { release.pending = false; ownerFactory.mockRestore(); vi.unstubAllEnvs(); });

describe("Antigravity run start while the profile is pending", () => {
  beforeEach(() => { release.pending = true; });

  it.each([["plugin Runner-task", pluginTarget], ["Core sandbox", sandboxTarget]] as const)(
    "refuses a %s run without an operator grant before any launch", async (_name, target) => {
      expect(antigravityReleasePending()).toBe(true);
      await expect(runStart(antigravityExecution(), target())).rejects.toThrow(INELIGIBLE);
      expect(describeTask).not.toHaveBeenCalled();
      expect(ownerFactory).not.toHaveBeenCalled();
      expect(backend.options).toBeUndefined();
    });

  it("admits a granted Core sandbox run past the gate, and still refuses the same grant on a plugin Runner-task target", async () => {
    grant.admitted = true;
    const db = emptyDb();
    await expect(runStart(antigravityExecution(), sandboxTarget(), db)).rejects.toThrow(COORDINATOR_CLAIM);
    expect(db.reads).toEqual(coordinatorReads);
    expect(grant.targets).toContainEqual({ platform: "linux", architecture: "x64" });
    await expect(runStart(antigravityExecution(), pluginTarget())).rejects.toThrow(INELIGIBLE);
    expect(describeTask).not.toHaveBeenCalled();
    expect(ownerFactory).not.toHaveBeenCalled();
  });
});

describe("Antigravity run start once the profile is released", () => {
  it("passes the gate on a plugin Runner-task target and refuses state saved under another profile version", async () => {
    expect(antigravityReleasePending()).toBe(false);
    const db = emptyDb();
    await expect(runStart(antigravityExecution(), pluginTarget(), db)).rejects.toThrow(COORDINATOR_CLAIM);
    expect(db.reads).toEqual([{ table: "environment_leases", locked: false }, ...coordinatorReads]);
    const older = antigravityExecution();
    (older.provider as { profile: { agentProfileVersion: number } }).profile.agentProfileVersion -= 1;
    const olderDb = emptyDb();
    await expect(runStart(older, pluginTarget(), olderDb)).rejects.toBeInstanceOf(NativeProviderStateIncompatibleError);
    expect(olderDb.reads).toEqual([]);
  });

  it.each(["api_key", "sign_in"] as const)("hands a %s plugin Runner task only its typed credential", async method => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "antigravity-run-start-")));
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(directory, "runner"));
    const managedHome = join(directory, "managed-home");
    await mkdir(join(managedHome, "antigravity-acp"), { recursive: true, mode: 0o700 });
    const signIn = JSON.stringify({
      client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", client_secret: "fixture-client-secret",
      refresh_token: "fixture-google-refresh", token_uri: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"],
    });
    await writeFile(join(managedHome, "antigravity-acp", "acp_token.json"), signIn, { mode: 0o600 });
    const owner = { launcher: vi.fn(), registration: vi.fn(), readWorkspaceFile: vi.fn(), isRetired: () => false, rebind: vi.fn(),
      driver: { authorityRunId: "run", prepareLaunch: vi.fn(), runnerProcessLauncher: vi.fn(), controlPlaneRegistration: vi.fn() } };
    ownerFactory.mockReturnValue(owner as never);
    const handoff = vi.spyOn(pluginCredentialWriteback, "registerPluginTaskCredentialHandoff").mockResolvedValue(undefined as never);
    try {
      await createRunnerdBackend({ db: emptyDb(), execution: antigravityExecution(), runnerInstanceId: "antigravity-run-start",
        runnerIngressAuthorized: true, managedAiCredentialHome: managedHome, managedAiCredentialIdentity: "revision",
        managedAiAccountIdentity: "account",
        ...(method === "sign_in" ? { managedAiCredentialWriteback: { grantId: "10000000-0000-4000-8000-0000000000a1",
          secretId: "10000000-0000-4000-8000-0000000000a2", sessionEpoch: 1, versionSelector: "latest" as const,
          google: { credentialSha256: "c".repeat(64) } } } : {}),
        runnerEnvironment: { ...(method === "api_key" ? { GEMINI_API_KEY: "fixture-gemini" } : {}),
          GOOGLE_API_KEY: "ambient-google", GEMINI_HOME: "/ambient" },
        runnerExecutionTarget: pluginTarget() });
      await backend.options!.codexTransportFactory!();
      expect(ownerFactory).toHaveBeenCalledOnce();
      expect(ownerFactory).toHaveBeenCalledWith(expect.objectContaining({ credential: { type: "provider-env", provider: "antigravity",
        environment: method === "api_key" ? { GEMINI_API_KEY: "fixture-gemini" } : { PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: signIn } } }));
      expect(handoff).toHaveBeenCalledTimes(method === "sign_in" ? 1 : 0);
    } finally {
      handoff.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
