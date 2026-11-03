import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";

import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type { CodexWorkingDirectoryAuthority } from "../drivers/codex/codex-boundaries.js";
import { createNativeSessionBackend } from "../index.js";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest,
  type PreparedRunnerProviderLaunch, type RunnerProviderLaunchRequirements } from "./runner-provider-launch.js";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

const fakeCodex = resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server");
const identity = { runnerInstanceId: "runner-plugin", environmentLeaseId: "lease-plugin", runId: "run",
  normalizedSessionId: "session", turnId: "turn-plugin", itemId: "item-plugin" };
const sessionIdentity = { runId: "run", sessionId: "session", companyId: "company", issueId: "issue", agentId: "agent" };

function execution(): NativeExecutionInput {
  return {
    schema: "paperclip.native-execution-input.v1",
    binding: { companyId: "company", runId: "run", issueId: "issue", agentId: "agent", executionWorkspaceId: "workspace" },
    task: { identifier: "PAP-1", title: "Plugin-owned workspace", description: null, prompt: "Complete the task.", workMode: "standard" },
    workspace: { cwd: "/controller/workspace", repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: "session", driverKind: "codex_app_server", protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    provider: { kind: "codex", model: null, approvalPolicy: "never" },
    completionContract: { id: "contract", sha256: "sha256", schemaVersion: "1",
      contract: { revision: "revision", objective: "Complete the task.", criteria: [{ id: "objective", requirement: "Complete the task." }] } },
    interactionResponses: [], credentialBindings: [],
  };
}

/** Core's plugin-backed backend: no host environment, runnerd owns process launch. */
async function pluginBackend(root: string, cwd: string, authority: CodexWorkingDirectoryAuthority) {
  const binary = defaultCapabilityRunnerdBinary();
  const runnerArtifact = { version: "0.3.0", digest: `sha256:${createHash("sha256").update(await readFile(binary)).digest("hex")}` };
  const prepareLaunch = vi.fn(async (requirements: RunnerProviderLaunchRequirements, recovery?: PreparedRunnerProviderLaunch) =>
    recovery ?? { configurationId: `plugin-${requirements.identity.runId}`, requirementsDigest: runnerLaunchRequirementsDigest(requirements),
      provider: createRunnerProviderLaunch(requirements, { options: { codexArgs: ["--state-file", join(root, "fake-codex-state.json"),
        "--request-log", join(root, "codex-requests.jsonl")] }, root, cwd, codexHome: join(root, "guest-codex-home"),
      codexCommand: fakeCodex, providerNodeCommand: process.execPath, opencodeProxyPath: "", acpxSidecarPath: "" }) });
  const launches: Array<NodeJS.ProcessEnv> = [];
  const registered = new WeakSet<object>();
  const backend = createNativeSessionBackend(execution(), {
    runnerInstanceId: identity.runnerInstanceId, environment: {}, workingDirectoryAuthority: authority,
    codexTransportFactory: recovery => createCapabilityRunnerdCodexTransport({
      provider: "codex", stateDirectory: join(root, "state"), runnerArtifact, prepareLaunch, prpIdentity: identity,
      externallySandboxed: true, baseInstructions: recovery?.baseInstructions, resumeProviderSession: recovery?.persistedSession,
      resumeActiveTurnId: recovery?.persistedSession?.activeTurnId ?? null,
      controlPlaneRegistration: async controlPlane => {
        if (!registered.has(controlPlane)) { await controlPlane.start(); registered.add(controlPlane); }
        return { release: () => undefined };
      },
      runnerProcessLauncher: spec => {
        launches.push(spec.environment);
        const child = spawn(binary, [...spec.args], { env: spec.environment, stdio: "ignore" });
        return { child, completion: new Promise((resolveExit, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => resolveExit({ code, signal, stdout: "", stderr: "" }));
        }) };
      },
    }).transport,
  });
  return { backend, prepareLaunch, launches };
}

it("reproduces the controller-side remote cwd requirement for plugin-owned launches", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-plugin-cwd-repro-"));
  try {
    const { backend, prepareLaunch, launches } = await pluginBackend(root, root, "remote_runner");
    await expect(backend.openSession({ identity: sessionIdentity, workingDirectory: "/controller/workspace" }))
      .rejects.toThrow("Remote Codex working directory requires an assigned workspace");
    expect(prepareLaunch).not.toHaveBeenCalled();
    expect(launches).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([
  ["prepared git worktree", "projects/repository/worktrees/workspace"],
  ["projectless agent home", "home/agent"],
])("opens and recovers a plugin-owned %s at the prepared cwd", async (_label, layout) => {
  const root = await mkdtemp(join(tmpdir(), "runner-plugin-cwd-"));
  // The runner is local in this fixture, so the prepared directory must exist
  // for runnerd. Core never receives or checks it before preparation.
  const cwd = join(root, "vm", layout);
  await mkdir(cwd, { recursive: true });
  try {
    const { backend, prepareLaunch, launches } = await pluginBackend(root, cwd, "runner_prepared_launch");
    // A caller-supplied directory neither authorizes nor overrides the launch.
    const session = await backend.openSession({ identity: sessionIdentity, workingDirectory: "/controller/caller-choice" });
    const snapshot = await session.snapshot();
    expect(snapshot.workingDirectory).toBe(cwd);
    expect(prepareLaunch).toHaveBeenCalledOnce();
    expect(JSON.stringify(prepareLaunch.mock.calls[0]![0])).not.toContain("/controller/");
    const requests = (await readFile(join(root, "codex-requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.find(request => request.method === "thread/start").params).toMatchObject({ cwd });
    expect(JSON.stringify(requests)).not.toContain("/controller/");
    for (const environment of launches) {
      for (const key of ["HOME", "PATH", "CODEX_HOME", "PAPERCLIP_WORKSPACE_CWD", "OPENAI_API_KEY"]) expect(environment).not.toHaveProperty(key);
    }
    await session.close({ reason: "controller restart" });

    const restarted = await pluginBackend(root, join(root, "unused"), "runner_prepared_launch");
    const recovered = await restarted.backend.recoverSession!(snapshot, { signal: new AbortController().signal });
    expect(recovered).toMatchObject({ recovered: true });
    if (!recovered.recovered) throw new Error(recovered.reason);
    expect((await recovered.session.snapshot()).workingDirectory).toBe(cwd);
    // Recovery reuses the saved preparation instead of resolving a new directory.
    expect(restarted.prepareLaunch.mock.calls[0]![1]).toMatchObject({ configurationId: "plugin-run" });
    await recovered.session.close({ reason: "test complete" });

    const moved = await pluginBackend(root, join(root, "unused"), "runner_prepared_launch");
    await expect(moved.backend.recoverSession!({ ...snapshot, workingDirectory: join(root, "elsewhere") },
      { signal: new AbortController().signal })).resolves.toMatchObject({ recovered: false });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

it("does not submit work when plugin launch preparation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-plugin-cwd-fail-"));
  const registration = vi.fn(); const launch = vi.fn();
  try {
    const backend = createNativeSessionBackend(execution(), {
      environment: {}, workingDirectoryAuthority: "runner_prepared_launch",
      codexTransportFactory: () => createCapabilityRunnerdCodexTransport({ provider: "codex", stateDirectory: root, prpIdentity: identity,
        runnerArtifact: { version: "fixture", digest: `sha256:${"a".repeat(64)}` },
        controlPlaneRegistration: registration, runnerProcessLauncher: launch,
        prepareLaunch: async () => { throw new Error("Task workspace is not prepared"); } }).transport,
    });
    await expect(backend.openSession({ identity: sessionIdentity, workingDirectory: "/controller/workspace" }))
      .rejects.toThrow("Task workspace is not prepared");
    expect(registration).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([
  ["relative", "projects/workspace"],
  ["root", "/"],
  ["unnormalized", "/projects/../etc"],
  ["control character", "/projects/work\nspace"],
])("rejects a %s prepared cwd before registration or launch", async (_label, cwd) => {
  const root = await mkdtemp(join(tmpdir(), "runner-plugin-cwd-invalid-"));
  const registration = vi.fn(); const launch = vi.fn();
  try {
    const backend = createNativeSessionBackend(execution(), {
      environment: {}, workingDirectoryAuthority: "runner_prepared_launch",
      codexTransportFactory: () => createCapabilityRunnerdCodexTransport({ provider: "codex", stateDirectory: root, prpIdentity: identity,
        runnerArtifact: { version: "fixture", digest: `sha256:${"a".repeat(64)}` },
        controlPlaneRegistration: registration, runnerProcessLauncher: launch,
        prepareLaunch: async requirements => ({ configurationId: "invalid-cwd", requirementsDigest: runnerLaunchRequirementsDigest(requirements),
          provider: { ...createRunnerProviderLaunch(requirements, { options: { codexArgs: [] }, root, cwd: "/projects/workspace",
            codexHome: root, codexCommand: "/unused/codex", providerNodeCommand: "", opencodeProxyPath: "", acpxSidecarPath: "" }), cwd } }) }).transport,
    });
    await expect(backend.openSession({ identity: sessionIdentity, workingDirectory: "/controller/workspace" }))
      .rejects.toThrow("runner_prepared_launch_working_directory_invalid");
    expect(registration).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});
