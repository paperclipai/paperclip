import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const processResult = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/adapter-utils/execution-target", async original => ({
  ...await original<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  runAdapterExecutionTargetProcess: processResult,
}));

describe("Claude resumed accounting through execution and checkpoints", () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.clearAllMocks();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  it.each([
    { name: "success", exitCode: 0, timedOut: false },
    { name: "failure", exitCode: 1, timedOut: false },
    { name: "timeout after result", exitCode: 1, timedOut: true },
  ].flatMap(outcome => [false, true].flatMap(truncated => [false, true].map(checkpoint => ({ ...outcome, truncated, checkpoint }))))
    .flatMap(testCase => [false, true].map(lateBaseline => ({ ...testCase, lateBaseline }))))
  ("accounts for $name (truncated=$truncated, checkpoint=$checkpoint, lateBaseline=$lateBaseline)", async ({ exitCode, timedOut, truncated, checkpoint, lateBaseline }) => {
    const directory = await mkdtemp(join(tmpdir(), "paperclip-claude-accounting-"));
    directories.push(directory);
    const command = join(directory, "runtime");
    await writeFile(command, "#!/bin/sh\nprintf 'fixture\\n'\n", { mode: 0o755 });
    const model = "fixture-model";
    const previous = { inputTokens: 110, outputTokens: 31, cacheReadInputTokens: 200, cacheCreationInputTokens: 20, costUSD: 0.00031 };
    const current = { inputTokens: 230, outputTokens: 63, cacheReadInputTokens: 400, cacheCreationInputTokens: 40, costUSD: 0.000635 };
    const onUsage = checkpoint ? vi.fn() : undefined;
    const onMeta = vi.fn();
    processResult.mockImplementation(async (_run, _target, _command, args, options) => {
      expect(args.slice(args.indexOf("--input-format"), args.indexOf("--input-format") + 2)).toEqual(["--input-format", "stream-json"]);
      const input = options.stdin.trim().split("\n").map((line: string) => JSON.parse(line));
      expect(input).toHaveLength(2);
      expect(input[0]).toMatchObject({ type: "control_request", request: { subtype: "get_usage", skip_behaviors: true } });
      expect(input[1]).toMatchObject({ type: "user", message: { role: "user", content: onMeta.mock.calls.at(-1)![0].prompt } });
      const events = [
        ...(lateBaseline ? [{ type: "assistant", message: {
          id: "first-message", content: [{ type: "text", text: "Work started before the baseline reply." }],
        } }] : []),
        { type: "control_response", response: { subtype: "success", request_id: input[0].request_id,
          response: { session: { total_cost_usd: 0.00031, model_usage: { [model]: previous } } } } },
        { type: "system", subtype: "init", session_id: "session-1", model },
        { type: "result", subtype: exitCode ? "error_during_execution" : "success", is_error: exitCode !== 0,
          session_id: "session-1", result: "finished", total_cost_usd: 0.000635, modelUsage: { [model]: current } },
      ];
      const stdout = events.map(event => JSON.stringify(event)).join("\n") + "\n";
      for (let offset = 0; offset < stdout.length; offset += 13) await options.onLog("stdout", stdout.slice(offset, offset + 13));
      // The transport caps stdout at its tail; the initial baseline is then
      // absent from the returned display text but remains in the log stream.
      const displayOutput = truncated
        ? events.slice(lateBaseline ? 2 : 1).map(event => JSON.stringify(event)).join("\n") + "\n"
        : stdout;
      return { exitCode, signal: null, timedOut, stdout: displayOutput, stderr: "", pid: 123, startedAt: new Date().toISOString() };
    });
    const { execute } = await import("../../../packages/adapters/claude-local/src/server/execute.js");
    const result = await execute({
      runId: "accounting-run",
      agent: { id: "agent", companyId: "company", name: "Accounting", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command, cwd: directory, model, paperclipRuntimeSkills: [],
        promptTemplate: 'A prompt with "quotes"\nand a second line.',
        env: { CLAUDE_CONFIG_DIR: directory, ANTHROPIC_API_KEY: "fixture" } },
      context: {}, onLog: async () => {}, onUsage, onMeta,
    });
    // An assistant event without counters still proves work has started. A
    // baseline received after it must not subtract any current-run work.
    const usage = lateBaseline
      ? { inputTokens: 270, outputTokens: 63, cachedInputTokens: 400 }
      : { inputTokens: 140, outputTokens: 32, cachedInputTokens: 200 };
    const costUsd = expect.closeTo(lateBaseline ? 0.000635 : 0.000325, 10);
    const expected = { usage, usageBasis: "per_run", costUsd,
      usageByModel: [{ model, usage, costUsd }] };
    expect(result).toMatchObject(expected);
    if (onUsage) expect(onUsage.mock.calls.at(-1)![0]).toMatchObject({ ...expected, complete: true });
  });
});
