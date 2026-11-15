import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import {
  RESOLVE_HOOK, installProviderFaultSeam, parseProviderDelays, withProviderFaultCheck, withProviderFaultRules,
  type ProviderFaultEvent, type ProviderFaultSeam,
} from "./provider-faults.js";
import { planWave, taskFaultSchedule } from "./scheduler.js";
import type { TaskPlan, WaveOptions } from "./types.js";

/** A stand-in Codex app-server: answers turn/start, acknowledges turn/interrupt, then sends the interrupted terminal. */
const FAKE_PROVIDER = `#!/usr/bin/env node
let buffer = "";
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.method === "turn/start") {
      // A multibyte character split across two writes must reach the runner intact.
      const delta = Buffer.from(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "h\\u00e9llo \\u2713" } }) + "\\n");
      const cut = delta.indexOf(Buffer.from("\\u2713")) + 1;
      process.stdout.write(delta.subarray(0, cut));
      setTimeout(() => {
        process.stdout.write(delta.subarray(cut));
        send({ id: message.id, result: { turn: { id: "turn-" + message.id } } });
        send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: "turn-" + message.id } } });
        for (const tool of ["write_document", "paperclip_finish"]) {
          send({ method: "item/completed", params: { threadId: message.params.threadId, item: { type: "dynamicToolCall", id: "call-" + tool, tool, status: "completed" } } });
        }
      }, 20);
    }
    if (message.method === "turn/interrupt") {
      // After the split delta above has finished, even when both requests arrive in one read.
      setTimeout(() => {
        send({ id: message.id, result: {} });
        send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted" } } });
      }, 50);
    }
  }
});
// Let replies scheduled above go out first.
process.stdin.on("end", () => setTimeout(() => process.exit(0), 100));
`;

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function seam(): Promise<{ seam: ProviderFaultSeam; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "chaos-provider-faults-"));
  roots.push(root);
  const provider = path.join(root, "fake-codex.mjs");
  await writeFile(provider, FAKE_PROVIDER);
  await chmod(provider, 0o755);
  const installed = await installProviderFaultSeam({ root, logPath: path.join(root, "provider-faults.jsonl"), realCommand: provider, realVersion: "0.0.0-test" });
  return { seam: installed, root };
}

function task(nonce: string, rule: TaskPlan["providerFault"]): TaskPlan {
  return { taskId: "t01", index: 0, workload: "Q1", adapter: "codex", fault: rule!.kind, fireAfterMs: 0, holdMs: 0, followUpAfterMs: null, nonce, providerFault: rule };
}

/** Drive one turn through the shim: start (with the prompt), interrupt, and collect what reaches the runner. */
async function turnThroughShim(root: string, prompt: string, waitMs = 600) {
  const shim = path.join(root, "provider-faults", "codex-package", "bin", "codex.js");
  const child = spawn(shim, ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
  const lines: Array<{ at: number; message: Record<string, any> }> = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const text = buffer.slice(0, index); let parsed; try { parsed = JSON.parse(text); } catch { throw new Error(`bad line: ${JSON.stringify(text)}`); } lines.push({ at: Date.now(), message: parsed });
      buffer = buffer.slice(index + 1);
    }
  });
  const write = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  write({ id: 1, method: "turn/start", params: { threadId: "thread-1", input: [{ type: "text", text: prompt }] } });
  await new Promise(resolve => setTimeout(resolve, 100));
  const interruptedAt = Date.now();
  write({ id: 2, method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } });
  await new Promise(resolve => setTimeout(resolve, waitMs));
  child.stdin.end();
  const code = await new Promise<number | null>(resolve => child.on("close", resolve));
  return {
    code, interruptedAt,
    acks: lines.filter(line => line.message.id === 2),
    terminals: lines.filter(line => line.message.method === "turn/completed"),
    starts: lines.filter(line => line.message.id === 1),
    deltas: lines.filter(line => line.message.method === "item/agentMessage/delta").map(line => line.message.params.delta as string),
    toolCompletions: lines.filter(line => line.message.method === "item/completed").map(line => line.message.params.item.tool as string),
  };
}

describe("provider message fault shim", () => {
  it("relays a turn unchanged when no rule is armed for the task", async () => {
    const { root } = await seam();
    const result = await turnThroughShim(root, "Chaos Q1 question abcd1234");
    expect(result.code).toBe(0);
    expect(result.starts).toHaveLength(1);
    expect(result.acks).toHaveLength(1);
    expect(result.terminals).toHaveLength(1);
    expect(result.deltas).toEqual(["h\u00e9llo \u2713"]);
  });

  it("PV1 delays only the interrupted turn's terminal, once per task", async () => {
    const { seam: installed, root } = await seam();
    await installed.arm([task("abcd1234", { kind: "PV1", message: "terminal", delayMs: 400 })]);
    const first = await turnThroughShim(root, "Chaos Q1 question abcd1234", 900);
    expect(first.acks).toHaveLength(1);
    expect(first.terminals).toHaveLength(1);
    expect(first.terminals[0]!.at - first.acks[0]!.at).toBeGreaterThanOrEqual(350);
    // A second provider process for the same task is not delayed again.
    const second = await turnThroughShim(root, "Chaos Q1 question abcd1234", 200);
    expect(second.terminals[0]!.at - second.acks[0]!.at).toBeLessThan(300);
    const events = await installed.eventsFor("abcd1234");
    expect(events.filter(event => event.event === "applied")).toMatchObject([{ kind: "PV1", message: "terminal", action: "delay", delayMs: 400, turnStatus: "interrupted" }]);
    expect(events.filter(event => event.event === "released")).toHaveLength(1);
  });

  it("PV2 drops the terminal and PV3 duplicates it; other tasks are untouched", async () => {
    const { seam: installed, root } = await seam();
    await installed.arm([task("aaaa0000", { kind: "PV2", message: "terminal" }), task("bbbb1111", { kind: "PV3", message: "terminal" })]);
    expect((await turnThroughShim(root, "nonce aaaa0000")).terminals).toHaveLength(0);
    expect((await turnThroughShim(root, "nonce bbbb1111")).terminals).toHaveLength(2);
    expect((await turnThroughShim(root, "nonce cccc2222")).terminals).toHaveLength(1);
  });

  it("occurrence 2 passes the task's first interrupted terminal and drops its second (Q4)", async () => {
    const { seam: installed, root } = await seam();
    await installed.arm([task("ffff5555", { kind: "PV2", message: "terminal", occurrence: 2 })]);
    expect((await turnThroughShim(root, "nonce ffff5555")).terminals).toHaveLength(1);
    expect((await turnThroughShim(root, "nonce ffff5555")).terminals).toHaveLength(0);
    expect((await turnThroughShim(root, "nonce ffff5555")).terminals).toHaveLength(1);
    const events = await installed.eventsFor("ffff5555");
    expect(events.filter(event => event.event === "passed")).toMatchObject([{ kind: "PV2", occurrence: 2, seen: 1 }]);
    expect(events.filter(event => event.event === "applied")).toMatchObject([{ kind: "PV2", message: "terminal", action: "drop" }]);
  });

  it("targets the interruption acknowledgement", async () => {
    const { seam: installed, root } = await seam();
    await installed.arm([task("dddd3333", { kind: "PV2", message: "interrupt_ack" })]);
    const result = await turnThroughShim(root, "nonce dddd3333");
    expect(result.acks).toHaveLength(0);
    expect(result.starts).toHaveLength(1);
    expect(result.terminals).toHaveLength(1);
  });

  it("tool_completed drops the first Paperclip tool completion, never a finish or block (staging, 2026-11-11)", async () => {
    const { seam: installed, root } = await seam();
    await installed.arm([task("eeee4444", { kind: "PV2", message: "tool_completed" })]);
    const result = await turnThroughShim(root, "nonce eeee4444");
    expect(result.toolCompletions).toEqual(["paperclip_finish"]);
    expect(result.terminals).toHaveLength(1);
    expect((await installed.eventsFor("eeee4444")).filter(event => event.event === "applied"))
      .toMatchObject([{ kind: "PV2", message: "tool_completed", action: "drop", tool: "write_document" }]);
    expect((await turnThroughShim(root, "nonce eeee4444")).toolCompletions).toEqual(["write_document", "paperclip_finish"]);
    expect((await turnThroughShim(root, "nonce ffff5555")).toolCompletions).toEqual(["write_document", "paperclip_finish"]);
  });

  it("discards a held message when the provider exits first, as a dead provider would", async () => {
    const { seam: installed, root } = await seam();
    await installed.arm([task("eeee4444", { kind: "PV1", message: "terminal", delayMs: 5_000 })]);
    const result = await turnThroughShim(root, "nonce eeee4444", 200);
    expect(result.terminals).toHaveLength(0);
    const events = await installed.eventsFor("eeee4444");
    expect(events.filter(event => event.event === "held_message_discarded")).toMatchObject([{ kind: "PV1", message: "terminal", delayMs: 5_000 }]);
    const rule = { kind: "PV1" as const, message: "terminal" as const, delayMs: 5_000 };
    // The runner never saw the late terminal: that was a drop, not a delay.
    expect(withProviderFaultCheck({ verdict: "pass", checks: [] }, task("eeee4444", rule), events).checks[0])
      .toMatchObject({ name: "provider_fault_applied", ok: false, detail: expect.stringContaining("discarded=1") });
  });

  it("the server hook answers only the Codex package lookup and leaves no hook for children", async () => {
    const { seam: installed, root } = await seam();
    const probe = path.join(root, "probe.cjs");
    await writeFile(probe, `const { createRequire } = require("node:module");
console.log(JSON.stringify({ codex: createRequire(__filename).resolve("@openai/codex/package.json"), nodeOptions: process.env.NODE_OPTIONS ?? null }));`);
    const result = spawnSync(process.execPath, [probe], { encoding: "utf8",
      env: { ...process.env, ...installed.serverEnvironment, NODE_OPTIONS: `--no-warnings ${installed.serverEnvironment.NODE_OPTIONS}` } });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { codex: string; nodeOptions: string | null };
    expect(output.codex).toBe(installed.serverEnvironment.RESTART_CHAOS_CODEX_PACKAGE_JSON);
    expect(output.nodeOptions).toBe("--no-warnings");
    const manifest = JSON.parse(await readFile(output.codex, "utf8")) as { name: string; bin: { codex: string } };
    expect(manifest).toMatchObject({ name: "@openai/codex", bin: { codex: "bin/codex.js" } });
    expect(installed.serverEnvironment.NODE_OPTIONS).toContain(RESOLVE_HOOK);
  });
});

describe("provider fault planning", () => {
  const base: WaveOptions = { env: "local", adapters: ["codex"], workloads: ["Q1"], faults: [], providerFaults: ["PV1"], concurrency: 2, tasks: 4,
    seed: 7, budgetCents: 3000, pollMs: 3000 };

  it("parses PV kinds from --faults and sweeps PV1 delays across tasks", () => {
    const command = parseCommand(["--adapters", "codex", "--workloads", "Q1", "--faults", "PV1", "--provider-fault-delays", "5,14,18,25",
      "--tasks", "4", "--concurrency", "2", "--seed", "3"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options).toMatchObject({ faults: [], providerFaults: ["PV1"], providerFaultDelaysMs: [5_000, 14_000, 18_000, 25_000] });
    const plan = planWave("w-20261109T000000-s3", command.options);
    expect(plan.tasks.map(task => task.providerFault?.delayMs)).toEqual([5_000, 14_000, 18_000, 25_000]);
    expect(plan.tasks.every(task => task.fault === "PV1" && taskFaultSchedule(task).length === 0)).toBe(true);
  });

  it("parses provider faults and rejects combinations that cannot exercise them", () => {
    const command = parseCommand(["--adapters", "codex", "--workloads", "Q1,S1", "--faults", "PV2", "--tasks", "2", "--seed", "1"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options).toMatchObject({ faults: [], providerFaults: ["PV2"], workloads: ["Q1", "S1"] });
    expect(() => parseCommand(["--adapters", "codex", "--workloads", "Q1", "--faults", "K1,PV2"])).toThrow(/restart faults/);
    expect(() => parseCommand(["--adapters", "codex", "--workloads", "Q1,A1", "--faults", "PV1"])).toThrow(/remove A1/);
    expect(() => parseCommand(["--adapters", "codex", "--faults", "PV1"])).toThrow(/interrupt a provider turn/);
    expect(() => parseCommand(["--adapters", "codex,opencode", "--workloads", "Q1", "--faults", "PV1"])).toThrow(/cover codex and claude/);
    expect(() => parseCommand(["--adapters", "codex", "--workloads", "Q1", "--faults", "PV2", "--provider-fault-delays", "18"])).toThrow(/PV1/);
    expect(() => parseCommand(["--adapters", "codex", "--workloads", "Q1", "--provider-fault-message", "terminal"])).toThrow(/provider fault/);
    expect(() => parseCommand(["--adapters", "codex", "--workloads", "Q1", "--faults", "PV1", "--provider-fault-message", "result"])).toThrow(/terminal/);
    const toolCompleted = parseCommand(["--adapters", "codex", "--workloads", "A1", "--faults", "PV2", "--provider-fault-message", "tool_completed", "--tasks", "1", "--seed", "1"]);
    if (toolCompleted.mode !== "wave") throw new Error("expected a wave");
    expect(toolCompleted.options).toMatchObject({ providerFaults: ["PV2"], workloads: ["A1"], providerFaultMessage: "tool_completed" });
    expect(planWave("w-20261111T000000-s1", toolCompleted.options).tasks[0]!.providerFault).toEqual({ kind: "PV2", message: "tool_completed" });
    expect(() => parseCommand(["--adapters", "codex", "--workloads", "Q1", "--faults", "PV2", "--provider-fault-message", "tool_completed"])).toThrow(/save a document/);
    expect(() => parseCommand(["--adapters", "claude", "--workloads", "A1", "--faults", "PV2", "--provider-fault-message", "tool_completed"])).toThrow(/Codex only/);
    expect(() => parseCommand(["--adapters", "codex", "--workloads", "A1", "--faults", "PV2"])).toThrow(/interrupt a provider turn/);
    expect(() => parseProviderDelays("18,abc")).toThrow(/not a number/);
    expect(() => parseProviderDelays("601")).toThrow(/PV2/);
  });

  it("defaults PV1 to the 18 s late terminal and leaves restart tasks alone", () => {
    const tasks = withProviderFaultRules([
      { ...task("aa", { kind: "PV1", message: "terminal" }), providerFault: undefined, fireAfterMs: 30_000 },
      { ...task("bb", { kind: "PV1", message: "terminal" }), fault: "K1", providerFault: undefined, fireAfterMs: 30_000 },
    ], base);
    expect(tasks[0]).toMatchObject({ providerFault: { kind: "PV1", message: "terminal", delayMs: 18_000 }, fireAfterMs: 0 });
    expect(tasks[1]!.providerFault).toBeUndefined();
    expect(tasks[1]!.fireAfterMs).toBe(30_000);
  });

  it("fails a provider-fault task whose fault never happened", () => {
    const rule = { kind: "PV1" as const, message: "terminal" as const, delayMs: 18_000 };
    const pass = { verdict: "pass" as const, checks: [{ name: "issue_done", ok: true }] };
    const applied: ProviderFaultEvent[] = [{ at: 1, pid: 1, event: "applied", nonce: "aa", kind: "PV1", message: "terminal", action: "delay" },
      { at: 2, pid: 1, event: "released", nonce: "aa", kind: "PV1", message: "terminal" }];
    expect(withProviderFaultCheck(pass, task("aa", rule), applied).verdict).toBe("pass");
    expect(withProviderFaultCheck(pass, task("aa", rule), []).checks.at(-1)).toMatchObject({ name: "provider_fault_applied", ok: false });
    expect(withProviderFaultCheck(pass, { ...task("aa", rule), providerFault: undefined }, [])).toBe(pass);
  });
});
