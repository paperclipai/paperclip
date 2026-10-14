import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";

const processResult = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/adapter-utils/execution-target", async (original) => ({
  ...await original<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  runAdapterExecutionTargetProcess: processResult,
}));

type Execute = (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
const cases: Array<{ name: string; execute: () => Promise<Execute>; event: unknown; tokens?: { inputTokens: number; outputTokens: number; cachedInputTokens: number }; price: number | null }> = [
  { name: "codex", execute: async () => (await import("../../../packages/adapters/codex-local/src/server/execute.js")).execute,
    event: { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10 } }, tokens: { inputTokens: 20, cachedInputTokens: 100, outputTokens: 10 }, price: null },
  { name: "claude", execute: async () => (await import("../../../packages/adapters/claude-local/src/server/execute.js")).execute,
    event: { type: "assistant", message: { id: "m1", usage: { input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 10 }, content: [] } }, tokens: { inputTokens: 20, cachedInputTokens: 100, outputTokens: 10 }, price: null },
  { name: "opencode", execute: async () => (await import("../../../packages/adapters/opencode-local/src/server/execute.js")).execute,
    event: { type: "step_finish", part: { tokens: { input: 20, output: 10, cache: { read: 100 } }, cost: 0.004 } }, tokens: { inputTokens: 20, cachedInputTokens: 100, outputTokens: 10 }, price: 0.004 },
  { name: "pi", execute: async () => (await import("../../../packages/adapters/pi-local/src/server/execute.js")).execute,
    event: { type: "turn_end", message: { role: "assistant", content: [], usage: { input: 20, output: 10, cacheRead: 100, cost: { total: 0.004 } } } }, tokens: { inputTokens: 20, cachedInputTokens: 100, outputTokens: 10 }, price: 0.004 },
  { name: "cursor", execute: async () => (await import("../../../packages/adapters/cursor-local/src/server/execute.js")).execute,
    event: { type: "result", usage: { input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 10 }, total_cost_usd: 0.004 }, tokens: { inputTokens: 20, cachedInputTokens: 100, outputTokens: 10 }, price: 0.004 },
  { name: "gemini", execute: async () => (await import("../../../packages/adapters/gemini-local/src/server/execute.js")).execute,
    event: { type: "result", usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10 }, total_cost_usd: 0.004 }, tokens: { inputTokens: 20, cachedInputTokens: 100, outputTokens: 10 }, price: 0.004 },
  { name: "kimi", execute: async () => (await import("../../../packages/adapters/kimi-local/src/server/execute.js")).execute,
    event: { type: "assistant", content: "partial work" }, price: null },
];

describe("CLI adapter accounting on timeout", () => {
  // Keep OpenCode runtime config copies inside each fixture; host config may
  // include plugins and large dependency trees unrelated to accounting.
  const directories: string[] = [];
  afterEach(async () => { vi.clearAllMocks(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
  it.each(cases.filter(f => ["codex", "cursor", "opencode"].includes(f.name)))("$name preserves malformed optional counters through the checkpoint wrapper", async fixture => {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-invalid-counter-")); directories.push(dir);
    const command = join(dir, "runtime"); await writeFile(command, "#!/bin/sh\nprintf 'openai  test\\n'\n", { mode: 0o755 });
    const execute = await fixture.execute();
    for (const cached of ["private malformed counter", false, {}, 0, undefined]) for (const newline of [false, true]) {
      const event = fixture.name === "opencode"
        ? { type: "step_finish", part: { tokens: { input: 20, output: 10, cache: { read: cached } } } }
        : { type: fixture.name === "codex" ? "turn.completed" : "result", usage: { input_tokens: 20, output_tokens: 10, cached_input_tokens: cached } };
      const stdout = JSON.stringify(event) + (newline ? "\n" : "");
      processResult.mockImplementation(async (_run, _target, _command, _args, options) => {
        for (let offset = 0; offset < stdout.length; offset += 7) await options.onLog("stdout", stdout.slice(offset, offset + 7));
        return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: 123, startedAt: new Date().toISOString() };
      });
      const onUsage = vi.fn();
      const result = await execute({
        runId: "invalid-counter-run", agent: { id: "agent", companyId: "company", name: "Worker", adapterType: `${fixture.name}_local`, adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { engine: "cli", command, cwd: dir, model: fixture.name === "opencode" ? "openai/test" : "gpt-6-astra", paperclipRuntimeSkills: [],
          env: { XDG_CONFIG_HOME: dir, OPENAI_API_KEY: "fixture", OPENCODE_ALLOW_ALL_MODELS: "1" } },
        context: {}, onLog: async () => {}, onUsage,
      });
      const valid = cached === 0 || cached === undefined;
      expect(result.usageComplete, `${fixture.name}: ${JSON.stringify(cached)}`).toBe(valid);
      expect(result.usage).toEqual(valid ? { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0 } : undefined);
      expect(onUsage.mock.calls.at(-1)![0].complete).toBe(valid);
      if (!valid) {
        expect(result.costStatus).toBe("unpriced");
        expect(onUsage.mock.calls.every(([receipt]) => !receipt.complete && receipt.costStatus === "unpriced")).toBe(true);
      }
    }
  });
  it.each(cases.filter(fixture => fixture.name !== "kimi"))("$name flushes its attempt and surfaces checkpoint persistence failures", async (fixture) => {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-accounting-adapter-")); directories.push(dir);
    const command = join(dir, "runtime"); await writeFile(command, "#!/bin/sh\nprintf 'openai  test\\n'\n", { mode: 0o755 });
    const stdout = JSON.stringify(fixture.event);
    processResult.mockImplementation(async (_run, _target, _command, _args, options) => {
      // Local process logging catches callback failures. Finalization must
      // independently enforce receipt durability despite that contract.
      await options.onLog("stdout", stdout).catch(() => {});
      return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: 123, startedAt: new Date().toISOString() };
    });
    const onUsage = vi.fn();
    const context: AdapterExecutionContext = {
      runId: "test-run", agent: { id: "test-agent", companyId: "test-company", name: "Accounting", adapterType: `${fixture.name}_local`, adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command, cwd: dir, model: ["opencode", "pi"].includes(fixture.name) ? "openai/test" : fixture.name === "cursor" ? "gpt-5" : "test", paperclipRuntimeSkills: [],
        env: { XDG_CONFIG_HOME: dir, OPENAI_API_KEY: "test-placeholder", ANTHROPIC_API_KEY: "test-placeholder", GEMINI_API_KEY: "test-placeholder", OPENCODE_ALLOW_ALL_MODELS: "1", CLAUDE_CONFIG_DIR: dir } },
      context: {}, onLog: async () => {}, onUsage,
    };
    const execute = await fixture.execute();
    const initial = await execute(context);
    const complete = !["claude", "pi"].includes(fixture.name);
    expect(initial.usageComplete).toBe(complete);
    expect(onUsage.mock.calls.at(-1)![0]).toMatchObject({ usage: fixture.tokens, costUsd: fixture.price, complete });
    if (fixture.name === "codex") {
      for (const type of ["turn.failed", "error", "turn.completed"]) {
        processResult.mockImplementationOnce(async (_run, _target, _command, _args, options) => {
          const failedOutput = JSON.stringify({ type }) + "\n";
          await options.onLog("stdout", failedOutput);
          return { exitCode: 1, signal: null, timedOut: false, stdout: failedOutput, stderr: "", pid: 123, startedAt: new Date().toISOString() };
        });
        const failed = await execute({ ...context, config: { ...context.config, model: "gpt-6-astra" } });
        expect(failed).toMatchObject({ usage: undefined, usageComplete: false, costStatus: "unpriced", costUsd: null });
        expect(onUsage.mock.calls.at(-1)![0]).toMatchObject({ usage: undefined, complete: false, costStatus: "unpriced", costUsd: null });
      }
      for (const [kind, auth, biller] of [["openrouter", "api_key", "openrouter"], ["custom", "api_key", "unknown"], ["local", "none", "unknown"]]) {
        const routed = await execute({ ...context, config: { ...context.config,
          managedAiRouting: { kind, auth }, env: { ...(context.config.env as object), OPENAI_API_KEY: "", PAPERCLIP_AI_PROVIDER_KEY: auth === "none" ? "" : "fixture" },
        } });
        expect(routed).toMatchObject({ billingType: "api", biller, costUsd: null });
        expect(onUsage.mock.calls.at(-1)![0]).toMatchObject({ billingType: "api", biller, costUsd: null });
      }
      for (const safer of [false, true]) {
        const priced = await execute({ ...context,
          config: { ...context.config, model: "gpt-5.4", fastMode: true },
          context: safer ? { codexTransientFallbackMode: "fresh_session_safer_invocation" } : {},
        });
        const expected = safer ? undefined : { serviceTier: "fast" };
        expect(priced.pricingContext).toEqual(expected);
        expect(onUsage.mock.calls.at(-1)![0].pricingContext).toEqual(expected);
      }
    }
    if (fixture.name === "opencode") {
      for (const kind of ["zero_usage", "zero_price", "missing", "partial"]) for (const timedOut of [false, true]) {
        const part = kind === "zero_usage" ? { tokens: { input: 0, output: 0 } } : kind === "zero_price" ? { cost: 0 } : kind === "partial" ? { tokens: { input: 2 } } : {};
        processResult.mockImplementationOnce(async (_run, _target, _command, _args, options) => {
          const output = JSON.stringify({ type: "step_finish", part });
          await options.onLog("stdout", output);
          return { exitCode: timedOut ? null : 0, signal: timedOut ? "SIGTERM" : null, timedOut, stdout: output, stderr: "", pid: 123, startedAt: new Date().toISOString() };
        });
        onUsage.mockClear();
        const reported = await execute(context);
        const complete = !timedOut && kind.startsWith("zero_");
        expect(reported.usageComplete).toBe(complete);
        expect(reported.usage).toEqual(kind === "zero_usage" ? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } : undefined);
        expect(reported.costUsd).toBe(kind === "zero_price" ? 0 : null);
        if (complete || !kind.startsWith("zero_")) expect(onUsage.mock.calls.at(-1)![0]).toMatchObject({ complete });
        if (!kind.startsWith("zero_")) expect(reported.costStatus).toBe("unpriced");
      }
    }
    if (fixture.name === "cursor") {
      for (const type of ["result", "step_finish"]) for (const timedOut of [false, true]) {
        processResult.mockImplementationOnce(async (_run, _target, _command, _args, options) => {
          const output = JSON.stringify({ type }) + "\n";
          await options.onLog("stdout", output);
          return { exitCode: timedOut ? null : 0, signal: timedOut ? "SIGTERM" : null, timedOut, stdout: output, stderr: "", pid: 123, startedAt: new Date().toISOString() };
        });
        const missing = await execute({ ...context, config: { ...context.config, model: "gpt-5.6-sol" } });
        expect(missing).toMatchObject({ usage: undefined, usageComplete: false, costStatus: "unpriced", costUsd: null });
        expect(onUsage.mock.calls.at(-1)![0]).toMatchObject({ usage: undefined, complete: false, costStatus: "unpriced", costUsd: null });
      }
      for (const explicitPrice of [false, true]) {
        processResult.mockImplementationOnce(async (_run, _target, _command, _args, options) => {
          const output = JSON.stringify({ type: "result", ...(explicitPrice ? { total_cost_usd: 0 } : { usage: { input_tokens: 0, output_tokens: 0 } }) }) + "\n";
          await options.onLog("stdout", output);
          return { exitCode: 0, signal: null, timedOut: false, stdout: output, stderr: "", pid: 123, startedAt: new Date().toISOString() };
        });
        const reported = await execute(context);
        expect(reported.usageComplete).toBe(true);
        expect(reported.usage).toEqual(explicitPrice ? undefined : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
        expect(reported.costUsd).toBe(explicitPrice ? 0 : null);
        expect(onUsage.mock.calls.at(-1)![0].complete).toBe(true);
      }
    }
    if (["claude", "pi", "opencode"].includes(fixture.name)) {
      processResult.mockImplementationOnce(async (_run, _target, _command, _args, options) => {
        await options.onLog("stdout", stdout).catch(() => {});
        return { exitCode: 1, signal: null, timedOut: false, stdout, stderr: "process failed", pid: 123, startedAt: new Date().toISOString() };
      });
      expect((await execute(context)).usageComplete).toBe(false);
      expect(onUsage.mock.calls.at(-1)![0].complete).toBe(false);
    }
    if (fixture.name === "claude") {
      const mixed = [
        { type: "system", subtype: "init", model: "actual-model" },
        { type: "result", total_cost_usd: 0.003, usage: { input_tokens: 3, output_tokens: 3 }, modelUsage: {
          "model-a": { inputTokens: 1, outputTokens: 1, costUSD: 0.001 },
          "model-b": { inputTokens: 2, outputTokens: 2, costUSD: 0.002 },
        } },
      ];
      processResult.mockImplementation(async (_run, _target, _command, _args, options) => {
        const output = mixed.map(item => JSON.stringify(item)).join("\n");
        await options.onLog("stdout", output).catch(() => {});
        return { exitCode: 0, signal: null, timedOut: false, stdout: output, stderr: "", pid: 123, startedAt: new Date().toISOString() };
      });
      await execute(context);
      expect(onUsage.mock.calls.at(-1)![0]).toMatchObject({ model: "mixed", costUsd: 0.003, complete: true, usageByModel: [
        { model: "model-a", costUsd: 0.001 }, { model: "model-b", costUsd: 0.002 },
      ] });
      delete (mixed[1] as { modelUsage?: unknown }).modelUsage;
      await execute(context);
      expect(onUsage.mock.calls.at(-1)![0]).toMatchObject({ model: "actual-model", complete: true });
    }
    onUsage.mockRejectedValue(new Error("Receipt persistence failed"));
    await expect(execute(context)).rejects.toThrow("Receipt persistence failed");
  });
  it.each(cases.filter(f => ["pi", "opencode"].includes(f.name)))("$name preserves full-stream accounting after stdout truncation", async (fixture) => {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-accounting-tail-")); directories.push(dir);
    const command = join(dir, "runtime"); await writeFile(command, "#!/bin/sh\nprintf 'anthropic  test\\n'\n", { mode: 0o755 });
    const execute = await fixture.execute();
    for (const checkpoint of [true, false]) for (const timedOut of [false, true]) for (const missingPrice of [false, true]) {
      const early = structuredClone(fixture.event) as any;
      if (missingPrice) {
        if (fixture.name === "pi") delete early.message.usage.cost;
        else delete early.part.cost;
      }
      const end = fixture.name === "pi" && !timedOut ? '\n{"type":"agent_end","messages":[]}' : "";
      const first = JSON.stringify(early) + "\n";
      const noise = JSON.stringify({ type: "text", part: { text: "x".repeat(9 * 1024 * 1024) } }) + "\n";
      const last = JSON.stringify(fixture.event) + end;
      processResult.mockImplementation(async (_run, _target, _command, _args, options) => {
        for (const record of [first, noise, last]) {
          for (let offset = 0; offset < record.length; offset += 65521) await options.onLog("stdout", record.slice(offset, offset + 65521));
        }
        return { exitCode: timedOut ? null : 0, signal: timedOut ? "SIGTERM" : null, timedOut, stdout: (first + noise + last).slice(-4 * 1024 * 1024), stderr: "", pid: 123, startedAt: new Date().toISOString() };
      });
      const onUsage = checkpoint ? vi.fn() : undefined;
      const result = await execute({
        runId: "tail-run", agent: { id: "test-agent", companyId: "test-company", name: "Accounting", adapterType: `${fixture.name}_local`, adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { engine: "cli", command, cwd: dir, model: "anthropic/test", paperclipRuntimeSkills: [], env: { XDG_CONFIG_HOME: dir, ANTHROPIC_API_KEY: "fixture", OPENAI_BASE_URL: "https://unrelated-proxy.example/v1", OPENROUTER_API_KEY: "unrelated-key", OPENCODE_ALLOW_ALL_MODELS: "1" } },
        context: {}, onLog: async () => {}, onUsage,
      });
      expect(result.usage).toMatchObject({ inputTokens: 40, outputTokens: 20, cachedInputTokens: 200 });
      expect(result.costUsd).toBe(missingPrice ? null : 0.008);
      expect(result.biller).toBe("anthropic");
      expect(result.usageComplete).toBe(!timedOut);
      if (onUsage) expect(onUsage.mock.calls.at(-1)![0]).toMatchObject({ usage: result.usage, costUsd: result.costUsd });
    }
  });

  it.each(cases)("$name retains observed accounting when the process times out", async (fixture) => {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-accounting-adapter-")); directories.push(dir);
    const command = join(dir, "runtime"); await writeFile(command, "#!/bin/sh\nprintf 'openai  test\\n'\n", { mode: 0o755 });
    processResult.mockResolvedValue({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: JSON.stringify(fixture.event), stderr: "", pid: 123, startedAt: new Date().toISOString() });
    const execute = await fixture.execute();
    const result = await execute({
      runId: "test-run", agent: { id: "test-agent", companyId: "test-company", name: "Accounting", adapterType: `${fixture.name}_local`, adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command, cwd: dir, model: ["opencode", "pi"].includes(fixture.name) ? "openai/test" : fixture.name === "cursor" ? "gpt-5" : "test", paperclipRuntimeSkills: [],
        env: { XDG_CONFIG_HOME: dir, OPENAI_API_KEY: "test-placeholder", ANTHROPIC_API_KEY: "test-placeholder", GEMINI_API_KEY: "test-placeholder", MOONSHOT_API_KEY: "test-placeholder", OPENCODE_ALLOW_ALL_MODELS: "1", CLAUDE_CONFIG_DIR: dir } },
      context: {}, onLog: async () => {},
    });
    expect(result.timedOut).toBe(true);
    expect(result.usageComplete).toBe(["codex", "cursor", "gemini", "kimi"].includes(fixture.name));
    if (fixture.name === "kimi") expect(result.costStatus).toBe("unpriced");
    expect(result.usageBasis).toBe("per_run");
    expect(result.provider).toBeTruthy();
    expect(result.billingType).toBeTruthy();
    if (fixture.tokens) expect(result.usage).toMatchObject(fixture.tokens);
    expect(result.costUsd).toBe(fixture.price);
  });
});


describe("incremental protocol accounting", () => {
  it.each(["turn.failed", "error", "turn.started"])("saves an unpriced Codex %s checkpoint before exposing its log", async (type) => {
    const { createCodexJsonlParser } = await import("../../../packages/adapters/codex-local/src/server/parse.js");
    const { createUsageCheckpointLog } = await import("@paperclipai/adapter-utils/usage-checkpoint");
    const consume = createCodexJsonlParser();
    const order: string[] = [];
    const saved = vi.fn(async () => { order.push("receipt"); });
    const parsed = vi.fn((records: string) => {
      const result = consume(records);
      return { usage: result.usageReported ? result.usage : undefined, complete: result.usageComplete, costStatus: "unpriced" as const, costUsd: null };
    });
    const log = createUsageCheckpointLog(async () => { order.push("log"); }, saved, parsed);
    await log("stdout", JSON.stringify({ type, message: "private provider failure" }) + "\n");
    // No flush or adapter return has happened: a host crash after this point
    // must preserve the unknown usage and keep the reservation pending.
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ complete: false, costUsd: null, costStatus: "unpriced", usage: undefined }));
    expect(order).toEqual(["receipt", "log"]);
    expect(parsed.mock.calls[0][0]).not.toContain("private provider failure");
  });

  it("keeps Claude message updates idempotent and preserves immutable snapshots", async () => {
    const { createClaudeStreamParser } = await import("../../../packages/adapters/claude-local/src/server/parse.js");
    const consume = createClaudeStreamParser();
    consume(JSON.stringify({ type: "system", subtype: "init", model: "actual-model" }));
    const message = (id: string, output: number) => JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: 2, output_tokens: output } } });
    const first = consume(message("one", 1));
    expect(first.usage).toMatchObject({ inputTokens: 2, outputTokens: 1 });
    expect(consume(message("one", 3)).usage).toMatchObject({ inputTokens: 2, outputTokens: 3 });
    expect(consume(message("two", 2)).usage).toMatchObject({ inputTokens: 4, outputTokens: 5 });
    expect(first.usage).toMatchObject({ inputTokens: 2, outputTokens: 1 });
    const final = consume(JSON.stringify({ type: "result", total_cost_usd: 1, usage: { input_tokens: 9, output_tokens: 8 } }));
    expect(final).toMatchObject({ model: "actual-model", costUsd: 1, usage: { inputTokens: 9, outputTokens: 8 } });
  });
  it.each(cases.filter(item => !["claude", "kimi"].includes(item.name)))("updates $name totals once per newly received record", async fixture => {
    const factories = {
      codex: async () => (await import("../../../packages/adapters/codex-local/src/server/parse.js")).createCodexJsonlParser(),
      cursor: async () => (await import("../../../packages/adapters/cursor-local/src/server/parse.js")).createCursorJsonlParser(),
      gemini: async () => (await import("../../../packages/adapters/gemini-local/src/server/parse.js")).createGeminiJsonlParser(),
      pi: async () => (await import("../../../packages/adapters/pi-local/src/server/parse.js")).createPiJsonlParser(),
      opencode: async () => (await import("../../../packages/adapters/opencode-local/src/server/parse.js")).createOpenCodeJsonlParser(),
    };
    const consume = await factories[fixture.name as keyof typeof factories]();
    const line = JSON.stringify(fixture.event);
    const first = consume(line);
    const second = consume(line);
    expect(first.usage).toMatchObject(fixture.tokens!);
    const multiplier = fixture.name === "codex" ? 1 : 2;
    expect(second.usage).toMatchObject(Object.fromEntries(Object.entries(fixture.tokens!).map(([key, count]) => [key, count * multiplier])));
  });
});


describe("process adapter bootstrap accounting proof", () => {
  const context = (config: Record<string, unknown>): AdapterExecutionContext => ({
    runId: `bootstrap-${crypto.randomUUID()}`,
    agent: { id: "agent", companyId: "company", name: "Process", adapterType: "process", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config, context: {}, onLog: async () => {},
  });
  it.each([{}, { command: "/nonexistent-paperclip-accounting-command" },
    { command: process.execPath, cwd: "/nonexistent-paperclip-accounting-directory" }])(
    "proves no provider work for a failure before spawn: %j", async (config) => {
      const { execute } = await import("../adapters/process/execute.js");
      const onSpawn = vi.fn();
      const result = await execute({ ...context(config), onSpawn });
      expect(result).toMatchObject({ exitCode: 1, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
      expect(result.errorMessage).toBeTruthy();
      expect(onSpawn).not.toHaveBeenCalled();
    },
  );
  it("does not invent bootstrap proof when a spawned process fails", async () => {
    const { execute } = await import("../adapters/process/execute.js");
    const onSpawn = vi.fn(async () => { throw new Error("Metadata persistence failed"); });
    const result = await execute({ ...context({ command: process.execPath, args: ["-e", "process.exit(7)"] }), onSpawn });
    expect(onSpawn).toHaveBeenCalledOnce();
    expect(result.exitCode).toBe(7);
    expect(result.executionRecovery).toBeUndefined();
  });
});
