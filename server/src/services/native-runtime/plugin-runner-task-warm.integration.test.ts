import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createRunnerdCodexTransport, createRunnerProviderLaunch, defaultCapabilityRunnerdBinary,
  runnerLaunchRequirementsDigest, readRunnerdArtifactBinding, type RunnerProcessLaunchSpec, type RunnerProviderLaunchRequirements } from "@paperclipai/paperclip-runner";
import { createPluginRunnerTaskOwner } from "./plugin-runner-task.js";

const fakeCodex = resolve(import.meta.dirname, "../../../../packages/paperclip-runner/runner/target/debug/fake-codex-app-server");

it.skipIf(!existsSync(defaultCapabilityRunnerdBinary()) || !existsSync(fakeCodex))(
  "keeps the current plugin owner through a real ordinary warm attachment", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugin-warm-owner-")), calls = join(root, "calls");
    const source = { runnerInstanceId: "warm-runner", environmentLeaseId: "warm-lease", runId: "first-run",
      normalizedSessionId: "warm-session", turnId: "first-turn", itemId: "first-item" };
    const target = { ...source, runId: "second-run", turnId: "second-turn", itemId: "second-item" };
    let spec: RunnerProcessLaunchSpec | undefined, child: ReturnType<typeof spawn> | undefined;
    let submits = 0, stopped = false;
    const task = async (operation: unknown): Promise<unknown> => {
      const op = operation as { kind: string; requirements: RunnerProviderLaunchRequirements; configurationId: string; provider: string };
      if (op.kind === "prepare") return { kind: "prepared", taskId: "warm-task", launch: {
        configurationId: `configuration-${op.requirements.identity.runId}`, requirementsDigest: runnerLaunchRequirementsDigest(op.requirements),
        provider: createRunnerProviderLaunch(op.requirements, { options: { codexArgs: ["--state-file", join(root, "fake.json"), "--call-log", calls, "--record-process-start"] },
          root, cwd: root, codexHome: join(root, "codex-home"), codexCommand: fakeCodex, providerNodeCommand: process.execPath,
          opencodeProxyPath: "", acpxSidecarPath: "" }),
      } };
      if (op.kind === "check_project_auth") return { kind: "project_auth", taskId: "warm-task", configurationId: op.configurationId, provider: op.provider, allowed: true };
      if (op.kind === "submit") {
        submits++;
        child = spawn(spec!.command, [...spec!.args], { cwd: spec!.cwd, env: spec!.environment, stdio: "ignore", detached: true });
      }
      if (op.kind === "stop") { stopped = true; if (child?.pid) process.kill(-child.pid, "SIGTERM"); }
      if (op.kind === "status") return { kind: "status", taskId: "warm-task", phase: stopped ? "cancelled" : "running",
        executionStopped: stopped && child?.exitCode != null, sessionStateAvailable: false };
      if (op.kind === "describe") return { kind: "description", taskId: "warm-task", warmTaskVersion: 1,
        runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` } };
      return { kind: "accepted", taskId: "warm-task" };
    };
    const input = { taskId: "warm-task", task, harness: "codex", projectIds: [], projectAuthCheckVersion: 1 as const,
      authorityRunId: source.runId, accountIdentity: "synthetic-account", warmTaskVersion: 1 as const, pollMs: 5 };
    const owner = createPluginRunnerTaskOwner(input);
    const launcher = owner.driver.runnerProcessLauncher!;
    const cores = new Set<import("@paperclipai/paperclip-runner").DurablePrpControlPlane>();
    const bundle = createRunnerdCodexTransport({ ...owner.driver,
      get authorityRunId() { return owner.driver.authorityRunId; },
      runnerProcessLauncher: next => { spec = next; return launcher(next); },
      stateDirectory: root, runnerBinary: defaultCapabilityRunnerdBinary(), runnerArtifact: readRunnerdArtifactBinding(defaultCapabilityRunnerdBinary()), prpIdentity: source,
      codexCommand: fakeCodex, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
      // This fixture isolates ordinary owner rotation from hosted ingress timing.
      controlPlaneRegistration: async core => {
        if (!cores.has(core)) { cores.add(core); await core.start(); }
        return { connectUrl: core.connectUrl, release: () => {} };
      },
    });
    try {
      const opened = await bundle.transport.request("thread/start", { cwd: root, dynamicTools: [] });
      const turn = async () => {
        await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Complete once." }] });
        for await (const event of bundle.transport.notifications()) if (event.method === "turn/completed") return;
        throw new Error("Warm fixture ended without completion");
      };
      await turn();
      const pid = child!.pid;
      owner.rebind({ ...input, authorityRunId: target.runId });
      await bundle.transport.attachRun!(target);
      await turn();
      const retained = await bundle.transport.request("thread/read", {});
      expect(retained.thread).toMatchObject({ id: (opened.thread as { id: string }).id });
      expect(child!.pid).toBe(pid); expect(submits).toBe(1);
      const methods = (await readFile(calls, "utf8")).trim().split(/\r?\n/);
      expect(methods.filter(method => method === "process-start")).toHaveLength(1);
      expect(methods.filter(method => method === "turn/start")).toHaveLength(2);
    } finally {
      const providerPid = bundle.evidence().providerPid;
      await bundle.detachControllerForRestart().catch(() => undefined);
      for (const pid of [providerPid, child?.pid]) if (pid) try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      for (const core of cores) await core.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000,
);
