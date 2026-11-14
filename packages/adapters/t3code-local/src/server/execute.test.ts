import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

const FAKE_T3 = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dir = process.env.T3_FAKE_DIR;
const args = process.argv.slice(2);
const stdin = args.includes("-") ? fs.readFileSync(0, "utf8") : null;
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, stdin }) + "\\n");
const planPath = path.join(dir, "plan.json");
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const step = (plan[args.slice(0, 2).join(" ")] || []).shift() || {};
fs.writeFileSync(planPath, JSON.stringify(plan));
if (step.stdout) process.stdout.write(step.stdout);
if (step.stderr) process.stderr.write(step.stderr);
setTimeout(() => process.exit(step.exit || 0), (step.sleep || 0) * 1000);
`;

type Step = { stdout?: string; stderr?: string; exit?: number; sleep?: number };

const tempRoots: string[] = [];

async function setup(plan: Record<string, Step[]>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-t3code-local-"));
  tempRoots.push(root);
  const fakeDir = path.join(root, "fake");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(fakeDir);
  await fs.mkdir(workspace);
  const command = path.join(fakeDir, "t3");
  await fs.writeFile(command, FAKE_T3, { mode: 0o755 });
  await fs.writeFile(path.join(fakeDir, "plan.json"), JSON.stringify(plan));
  const calls = async () =>
    (await fs.readFile(path.join(fakeDir, "calls.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; stdin: string | null });
  return { command, fakeDir, workspace, calls };
}

function makeContext(
  env: Awaited<ReturnType<typeof setup>>,
  overrides: Partial<AdapterExecutionContext> & { config?: Record<string, unknown> } = {},
): AdapterExecutionContext {
  const { config, ...rest } = overrides;
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "T3 Agent", adapterType: "t3code_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: env.command, cwd: env.workspace, env: { T3_FAKE_DIR: env.fakeDir }, ...config },
    context: {},
    onLog: async () => {},
    ...rest,
  };
}

const result = (fields: Record<string, unknown>) =>
  `T3 log line\n${JSON.stringify({ threadId: "thr-1", runId: "r-1", reply: null, error: null, ...fields })}\n`;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("t3code_local execute", () => {
  it("starts a thread with the message on stdin and stores the thread", async () => {
    const env = await setup({ "thread start": [{ stdout: result({ status: "completed", reply: "All done" }) }] });
    const onProviderStopped = vi.fn(async () => {});
    const res = await execute(makeContext(env, {
      config: { provider: "codex", model: "gpt-5.5", promptTemplate: "Work on {{agent.name}}" },
      onProviderStopped,
    }));

    const [call] = await env.calls();
    expect(call.args).toEqual([
      "thread", "start", env.workspace, "-",
      "--provider", "codex", "--model", "gpt-5.5",
      "--title", "Paperclip: T3 Agent (run-1)", "--wait", "--json",
    ]);
    expect(call.stdin).toContain("Work on T3 Agent");
    expect(res).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      summary: "All done",
      sessionParams: { threadId: "thr-1", cwd: env.workspace, provider: "codex", model: "gpt-5.5" },
      sessionDisplayId: "thr-1",
      costStatus: "unpriced",
    });
    expect(onProviderStopped).toHaveBeenCalledOnce();
  });

  it("queues the message on the stored thread when the cwd matches", async () => {
    const env = await setup({ "thread send": [{ stdout: result({ threadId: "thr-old", status: "completed", reply: "ok" }) }] });
    const res = await execute(makeContext(env, {
      runtime: { sessionId: null, sessionParams: { threadId: "thr-old", cwd: env.workspace }, sessionDisplayId: null, taskKey: null },
    }));

    expect((await env.calls()).map((call) => call.args)).toEqual([["thread", "send", "thr-old", "-", "--wait", "--json"]]);
    expect(res).toMatchObject({ exitCode: 0, summary: "ok", sessionDisplayId: "thr-old" });
  });

  it("starts a new thread when the provider or model changed", async () => {
    const env = await setup({ "thread start": [{ stdout: result({ threadId: "thr-new", status: "completed" }) }] });
    const res = await execute(makeContext(env, {
      config: { provider: "codex", model: "gpt-5.5" },
      runtime: {
        sessionId: null,
        sessionParams: { threadId: "thr-old", cwd: env.workspace, provider: "codex", model: "gpt-5.4" },
        sessionDisplayId: null,
        taskKey: null,
      },
    }));

    expect((await env.calls()).map((call) => call.args.slice(0, 2).join(" "))).toEqual(["thread start"]);
    expect(res.sessionParams).toEqual({ threadId: "thr-new", cwd: env.workspace, provider: "codex", model: "gpt-5.5" });
  });

  it("treats a session without a stored model as the project default", async () => {
    const env = await setup({ "thread start": [{ stdout: result({ threadId: "thr-new", status: "completed" }) }] });
    await execute(makeContext(env, {
      config: { provider: "codex", model: "gpt-5.5" },
      runtime: { sessionId: null, sessionParams: { threadId: "thr-old", cwd: env.workspace }, sessionDisplayId: null, taskKey: null },
    }));

    expect((await env.calls()).map((call) => call.args.slice(0, 2).join(" "))).toEqual(["thread start"]);
  });

  it("resumes when the stored provider and model match", async () => {
    const env = await setup({ "thread send": [{ stdout: result({ threadId: "thr-old", status: "completed" }) }] });
    await execute(makeContext(env, {
      config: { provider: "codex", model: "gpt-5.5" },
      runtime: {
        sessionId: null,
        sessionParams: { threadId: "thr-old", cwd: env.workspace, provider: "codex", model: "gpt-5.5" },
        sessionDisplayId: null,
        taskKey: null,
      },
    }));

    expect((await env.calls()).map((call) => call.args.slice(0, 2).join(" "))).toEqual(["thread send"]);
  });

  it("starts a new thread when the stored thread belongs to another cwd", async () => {
    const env = await setup({ "thread start": [{ stdout: result({ threadId: "thr-new", status: "completed" }) }] });
    const res = await execute(makeContext(env, {
      runtime: { sessionId: null, sessionParams: { threadId: "thr-old", cwd: "/elsewhere" }, sessionDisplayId: null, taskKey: null },
    }));

    expect((await env.calls()).map((call) => call.args.slice(0, 2).join(" "))).toEqual(["thread start"]);
    expect(res.sessionParams).toEqual({ threadId: "thr-new", cwd: env.workspace });
  });

  it("adds the workspace as a project and retries the start once", async () => {
    const env = await setup({
      "thread start": [
        { stderr: "No T3 Code project matches '/x'. Pass a project id or a path inside a project.\n", exit: 1 },
        { stdout: result({ status: "completed" }) },
      ],
    });
    const res = await execute(makeContext(env));

    expect((await env.calls()).map((call) => call.args.slice(0, 3))).toEqual([
      ["thread", "start", env.workspace],
      ["project", "add", env.workspace],
      ["thread", "start", env.workspace],
    ]);
    expect(res.exitCode).toBe(0);
  });

  it("reports a failed turn with the thread's error", async () => {
    const env = await setup({
      "thread start": [{ stdout: result({ status: "failed", error: "Provider crashed" }), stderr: "Thread thr-1 stopped with status failed\n", exit: 1 }],
    });
    const onProviderStopped = vi.fn(async () => {});
    const res = await execute(makeContext(env, { onProviderStopped }));

    expect(res).toMatchObject({ exitCode: 1, errorMessage: "Provider crashed", errorCode: null });
    expect(res.sessionParams).toEqual({ threadId: "thr-1", cwd: env.workspace });
    expect(onProviderStopped).toHaveBeenCalledOnce();
  });

  it("fails with the thread id when the agent waits for an answer in T3 Code", async () => {
    const env = await setup({ "thread start": [{ stdout: result({ status: "waiting" }), exit: 2 }] });
    const res = await execute(makeContext(env));

    expect(res).toMatchObject({
      exitCode: 2,
      errorCode: "t3code_needs_input",
      errorMessage: "T3 Code thread thr-1 is waiting for an answer. Open it in T3 Code to respond.",
      sessionParams: { threadId: "thr-1", cwd: env.workspace },
    });
  });

  it("starts a new thread when T3 Code no longer knows the stored thread", async () => {
    const env = await setup({
      "thread send": [{ stderr: "Thread thr-gone was not found.\n", exit: 1 }],
      "thread start": [{ stdout: result({ threadId: "thr-new", status: "completed" }) }],
    });
    const res = await execute(makeContext(env, {
      runtime: { sessionId: null, sessionParams: { threadId: "thr-gone", cwd: "" }, sessionDisplayId: null, taskKey: null },
    }));

    expect((await env.calls()).map((call) => call.args.slice(0, 2).join(" "))).toEqual(["thread send", "thread start"]);
    expect(res).toMatchObject({ exitCode: 0, sessionDisplayId: "thr-new", clearSession: false });
  });

  it("finds a timed-out thread by title and stops it before returning", async () => {
    const env = await setup({
      "thread start": [{ sleep: 10 }],
      "thread list": [{ stdout: `${JSON.stringify([{ threadId: "thr-2", title: "Paperclip: T3 Agent (run-1)" }])}\n` }],
      "thread stop": [
        { stdout: `${JSON.stringify({ threadId: "thr-2", runId: "r-2", status: "interrupt_requested" })}\n` },
        { stdout: `${JSON.stringify({ threadId: "thr-2", runId: "r-2", status: "interrupted" })}\n` },
      ],
    });
    const onProviderStopped = vi.fn(async () => {});
    const res = await execute(makeContext(env, { config: { timeoutSec: 1, graceSec: 1 }, onProviderStopped }));

    expect((await env.calls()).map((call) => call.args.slice(0, 2).join(" "))).toEqual([
      "thread start", "thread list", "thread stop", "thread stop",
    ]);
    expect(res).toMatchObject({ timedOut: true, errorMessage: "Timed out after 1s", errorCode: null });
    expect(res.sessionParams).toEqual({ threadId: "thr-2", cwd: env.workspace });
    expect(onProviderStopped).toHaveBeenCalledOnce();
  }, 20_000);

  it("keeps the stop unverified when an interrupted start never shows up in the thread list", async () => {
    const env = await setup({
      "thread start": [{ sleep: 10 }],
      "thread list": Array.from({ length: 20 }, () => ({ stdout: "[]\n" })),
    });
    const onProviderStopped = vi.fn(async () => {});
    const res = await execute(makeContext(env, { config: { timeoutSec: 1, graceSec: 1 }, onProviderStopped }));

    expect(res).toMatchObject({ timedOut: true, errorCode: "t3code_stop_unverified" });
    expect(res.errorMessage).toContain("did not list a thread for this run");
    expect((await env.calls()).filter((call) => call.args[0] === "thread" && call.args[1] === "list").length).toBeGreaterThan(1);
    expect(onProviderStopped).not.toHaveBeenCalled();
  }, 30_000);

  it("stops the thread when the run is cancelled", async () => {
    const env = await setup({
      "thread send": [{ sleep: 10 }],
      "thread stop": [{ stdout: `${JSON.stringify({ threadId: "thr-old", runId: null, status: "no_active_run" })}\n` }],
    });
    const onProviderStopped = vi.fn(async () => {});
    const onCancellationReady = vi.fn(async () => {});
    const controller = new AbortController();
    const res = await execute(makeContext(env, {
      runtime: { sessionId: null, sessionParams: { threadId: "thr-old" }, sessionDisplayId: null, taskKey: null },
      signal: controller.signal,
      onCancellationReady,
      onSpawn: async ({ pid }) => {
        setTimeout(() => { controller.abort(); process.kill(pid, "SIGTERM"); }, 300);
      },
      onProviderStopped,
    }));

    expect(onCancellationReady).toHaveBeenCalledOnce();
    expect((await env.calls()).at(-1)!.args).toEqual(["thread", "stop", "thr-old", "--json"]);
    expect(res).toMatchObject({ signal: "SIGTERM", errorCode: "cancelled", errorMessage: "Stopped by the operator" });
    expect(res.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged" });
    expect(onProviderStopped).toHaveBeenCalledOnce();
  }, 20_000);

  it("starts nothing when the run was stopped before setup", async () => {
    const env = await setup({});
    const controller = new AbortController();
    controller.abort();
    const res = await execute(makeContext(env, { signal: controller.signal }));

    expect(res).toMatchObject({
      errorCode: "cancelled",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    });
    expect(await env.calls()).toEqual([]);
  });

  it("launches no turn when Stop arrives while the invocation is being logged", async () => {
    const env = await setup({ "thread start": [{ stdout: result({ status: "completed" }) }] });
    const controller = new AbortController();
    const res = await execute(makeContext(env, {
      signal: controller.signal,
      onMeta: async () => { controller.abort(); },
    }));

    expect(await env.calls()).toEqual([]);
    expect(res).toMatchObject({ errorCode: "cancelled" });
  });

  it("does not probe for a stop when the T3 Code server cannot be reached", async () => {
    const env = await setup({
      "thread start": [{ stderr: "Could not reach the T3 Code server at http://127.0.0.1:3773.\n", exit: 1 }],
    });
    const res = await execute(makeContext(env));

    expect((await env.calls()).map((call) => call.args.slice(0, 2).join(" "))).toEqual(["thread start"]);
    expect(res.errorCode).not.toBe("t3code_stop_unverified");
    expect(res.exitCode).not.toBe(0);
  });

  it("ends a running project add as soon as Stop arrives", async () => {
    const env = await setup({
      "thread start": [
        { stderr: "No T3 Code project matches '/x'. Pass a project id or a path inside a project.\n", exit: 1 },
        { stdout: result({ status: "completed" }) },
      ],
      "project add": [{ sleep: 20 }],
    });
    const controller = new AbortController();
    const started = Date.now();
    const res = await execute(makeContext(env, {
      signal: controller.signal,
      onLog: async (_stream, chunk) => {
        if (chunk.includes("adding it as a project")) setTimeout(() => controller.abort(), 300);
      },
    }));

    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await env.calls()).map((call) => call.args.slice(0, 2).join(" "))).toEqual(["thread start", "project add"]);
    expect(res).toMatchObject({ errorCode: "cancelled" });
  }, 15_000);

  it("adds no project and starts no thread when Stop arrives before setup", async () => {
    const env = await setup({
      "thread start": [
        { stderr: "No T3 Code project matches '/x'. Pass a project id or a path inside a project.\n", exit: 1 },
        { stdout: result({ status: "completed" }) },
      ],
      "project add": [{ sleep: 0.3 }],
    });
    const controller = new AbortController();
    const res = await execute(makeContext(env, {
      signal: controller.signal,
      onLog: async (_stream, chunk) => { if (chunk.includes("adding it as a project")) controller.abort(); },
    }));

    expect((await env.calls()).map((call) => call.args.slice(0, 2).join(" "))).toEqual(["thread start"]);
    expect(res).toMatchObject({
      errorCode: "cancelled",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    });
  });

  it("does not start a replacement thread when Stop arrives before the resume retry", async () => {
    const env = await setup({
      "thread send": [{ stderr: "Thread thr-gone was not found.\n", exit: 1, sleep: 0.3 }],
      "thread start": [{ stdout: result({ status: "completed" }) }],
    });
    const controller = new AbortController();
    const res = await execute(makeContext(env, {
      runtime: { sessionId: null, sessionParams: { threadId: "thr-gone" }, sessionDisplayId: null, taskKey: null },
      signal: controller.signal,
      onSpawn: async () => { controller.abort(); },
    }));

    expect((await env.calls()).map((call) => call.args.slice(0, 2).join(" "))).toEqual(["thread send"]);
    expect(res).toMatchObject({ errorCode: "cancelled" });
  });

  it("bounds a hanging thread stop by the confirmation window", async () => {
    const env = await setup({
      "thread send": [{ sleep: 10 }],
      "thread stop": [{ sleep: 30 }],
    });
    const onProviderStopped = vi.fn(async () => {});
    const started = Date.now();
    const res = await execute(makeContext(env, {
      config: { timeoutSec: 1, graceSec: 1 },
      runtime: { sessionId: null, sessionParams: { threadId: "thr-old" }, sessionDisplayId: null, taskKey: null },
      onProviderStopped,
    }));

    expect(Date.now() - started).toBeLessThan(9_000);
    expect(res).toMatchObject({
      errorCode: "t3code_stop_unverified",
      errorMessage: "Timed out after 1s T3 Code did not confirm within 5s that thread thr-old stopped.",
    });
    expect(onProviderStopped).not.toHaveBeenCalled();
  }, 20_000);

  it("reports an unverified stop when the t3 CLI has no thread stop", async () => {
    const env = await setup({
      "thread send": [{ sleep: 10 }],
      "thread stop": [{ stderr: "Unknown subcommand \"stop\" for \"t3 thread\"\n", exit: 1 }],
    });
    const onProviderStopped = vi.fn(async () => {});
    const res = await execute(makeContext(env, {
      config: { timeoutSec: 1, graceSec: 1 },
      runtime: { sessionId: null, sessionParams: { threadId: "thr-old" }, sessionDisplayId: null, taskKey: null },
      onProviderStopped,
    }));

    expect(res).toMatchObject({
      timedOut: true,
      errorCode: "t3code_stop_unverified",
      errorMessage: "Timed out after 1s Could not confirm that T3 Code thread thr-old stopped: this t3 CLI has no `thread stop` command, so the run may still be active in T3 Code.",
    });
    expect(onProviderStopped).not.toHaveBeenCalled();
  }, 20_000);

  it("rejects a provider without a model before calling t3", async () => {
    const env = await setup({});
    const res = await execute(makeContext(env, { config: { provider: "codex" } }));

    expect(res).toMatchObject({ exitCode: 1, errorCode: "t3code_config_invalid" });
    expect(await env.calls()).toEqual([]);
  });
});
