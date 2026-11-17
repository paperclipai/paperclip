import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type { NativeExecutionInput } from "../contracts/native-execution.js";
import { createNativeSessionBackend } from "../index.js";
import type { RunnerProcessLaunchSpec } from "../control-plane/durable-prp-control-plane.js";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest,
  type RunnerProviderLaunchRequirements } from "./runner-provider-launch.js";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

const fakeCodex = resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server");
const identity = { runnerInstanceId: "runner-ticket", environmentLeaseId: "lease-ticket", runId: "run",
  normalizedSessionId: "session", turnId: "turn-ticket", itemId: "item-ticket" };
const sessionIdentity = { runId: "run", sessionId: "session", companyId: "company", issueId: "issue", agentId: "agent" };
const STAGING_MS = 75_000;

function execution(): NativeExecutionInput {
  return {
    schema: "paperclip.native-execution-input.v1",
    binding: { companyId: "company", runId: "run", issueId: "issue", agentId: "agent", executionWorkspaceId: "workspace" },
    task: { identifier: "PAP-1", title: "Slow staging", description: null, prompt: "Complete the task.", workMode: "standard" },
    workspace: { cwd: "/controller/workspace", repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: "session", driverKind: "codex_app_server", protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    provider: { kind: "codex", model: null, approvalPolicy: "never" },
    completionContract: { id: "contract", sha256: "sha256", schemaVersion: "1",
      contract: { revision: "revision", objective: "Complete the task.", criteria: [{ id: "objective", requirement: "Complete the task." }] } },
    interactionResponses: [], credentialBindings: [],
  };
}

afterEach(() => { vi.restoreAllMocks(); });

it("authenticates a runner whose remote staging outlasts the bootstrap ticket lifetime", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-ticket-refresh-"));
  const cwd = join(root, "vm", "workspace");
  await mkdir(cwd, { recursive: true });
  const binary = defaultCapabilityRunnerdBinary();
  const runnerArtifact = { version: "0.3.0", digest: `sha256:${createHash("sha256").update(await readFile(binary)).digest("hex")}` };
  const prepareLaunch = vi.fn(async (requirements: RunnerProviderLaunchRequirements) => ({
    configurationId: `plugin-${requirements.identity.runId}`, requirementsDigest: runnerLaunchRequirementsDigest(requirements),
    provider: createRunnerProviderLaunch(requirements, { options: { codexArgs: ["--state-file", join(root, "fake-codex-state.json")] },
      root, cwd, codexHome: join(root, "guest-codex-home"), codexCommand: fakeCodex,
      providerNodeCommand: process.execPath, opencodeProxyPath: "", acpxSidecarPath: "" }) }));
  const realNow = Date.now.bind(Date);
  let skewMs = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);
  const registered = new WeakSet<object>();
  const backend = createNativeSessionBackend(execution(), {
    runnerInstanceId: identity.runnerInstanceId, environment: {}, workingDirectoryAuthority: "runner_prepared_launch",
    codexTransportFactory: () => createCapabilityRunnerdCodexTransport({
      provider: "codex", stateDirectory: join(root, "state"), runnerArtifact, prepareLaunch, prpIdentity: identity,
      externallySandboxed: true,
      controlPlaneRegistration: async controlPlane => {
        if (!registered.has(controlPlane)) { await controlPlane.start(); registered.add(controlPlane); }
        return { release: () => undefined };
      },
      runnerProcessLauncher: (spec: RunnerProcessLaunchSpec) => {
        let kill: (signal?: NodeJS.Signals | number) => boolean = () => false;
        const child = { pid: undefined as number | undefined, exitCode: null, signalCode: null,
          kill: (signal?: NodeJS.Signals | number) => kill(signal) };
        const completion = (async () => {
          skewMs += STAGING_MS;
          const ticket = spec.refreshBootstrapTicket
            ? await spec.refreshBootstrapTicket()
            : spec.environment.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET;
          const runner = spawn(binary, [...spec.args], {
            env: { ...spec.environment, PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: ticket }, stdio: "ignore" });
          child.pid = runner.pid;
          kill = signal => runner.kill(signal);
          return await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
            (resolveExit, reject) => {
              runner.once("error", reject);
              runner.once("exit", (code, signal) => resolveExit({ code, signal, stdout: "", stderr: "" }));
            });
        })();
        return { child: child as never, completion };
      },
    }).transport,
  });
  try {
    const session = await backend.openSession({ identity: sessionIdentity, workingDirectory: cwd });
    expect((await session.snapshot()).workingDirectory).toBe(cwd);
    await session.close({ reason: "test complete" });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 45_000);
