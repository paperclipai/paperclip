import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOpenCodeAccounting } from "../../../packages/adapters/opencode-local/src/server/billing.js";
import { priceCodexReceipt } from "../services/codex-pricing.js";

const processResult = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/adapter-utils/execution-target", async (original) => ({
  ...await original<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  runAdapterExecutionTargetProcess: processResult,
}));
import { execute } from "../../../packages/adapters/opencode-local/src/server/execute.js";
const directories: string[] = [];
afterEach(async () => { vi.clearAllMocks(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const direct = { kind: "gateway", protocol: "chat", auth: "bearer", baseUrl: "https://api.openai.com/v1" };
const usage = { inputTokens: 118647, cachedInputTokens: 1407315, outputTokens: 5296 };

describe("managed OpenCode API accounting", () => {
  it.each([false, true])("keeps route attribution in streamed and final receipts (timeout=%s)", async timedOut => {
    const dir = await mkdtemp(join(tmpdir(), "managed-opencode-cost-")); directories.push(dir);
    const command = join(dir, "runtime"); await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const output = JSON.stringify({ type: "step_finish", part: { cost: 0,
      tokens: { input: usage.inputTokens, output: usage.outputTokens, cache: { read: usage.cachedInputTokens } } } }) + "\n";
    processResult.mockImplementation(async (_run, _target, _command, _args, options) => {
      for (let i = 0; i < output.length; i += 7) await options.onLog("stdout", output.slice(i, i + 7));
      return { exitCode: timedOut ? null : 0, signal: timedOut ? "SIGTERM" : null, timedOut, stdout: "truncated display output", stderr: "", pid: 123, startedAt: new Date().toISOString() };
    });
    const onUsage = vi.fn();
    const result = await execute({
      runId: "managed-api-run", agent: { id: "agent", companyId: "company", name: "Worker", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command, cwd: dir, model: "paperclip/gpt-6-sol", managedAiRouting: direct, paperclipRuntimeSkills: [],
        env: { HOME: dir, XDG_CONFIG_HOME: dir, PAPERCLIP_AI_PROVIDER_KEY: "fixture", OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context: {}, onLog: async () => {}, onUsage,
    });
    const identity = { provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-6-sol", costUsd: null, costStatus: "unpriced" };
    expect(result).toMatchObject({ ...identity, usage, usageComplete: !timedOut });
    expect(onUsage).toHaveBeenCalled();
    for (const [checkpoint] of onUsage.mock.calls) expect(checkpoint).toMatchObject(identity);
    const priced = priceCodexReceipt(onUsage.mock.calls.at(-1)![0]);
    if (timedOut) expect(priced).toMatchObject({ costUsd: null, costStatus: "unpriced", complete: false });
    else expect(priced).toMatchObject({ costStatus: "estimated", costUsdExact: "0.571717000", pricingProvenance: { source: "rate_card" } });
  });

  it.each(["https://proxy.example/v1", "https://api.openai.com.attacker.test/v1", "http://api.openai.com/v1"])("retains unknown spend for %s", baseUrl => {
    const receipt = { ...resolveOpenCodeAccounting({ ...direct, baseUrl }, { OPENAI_API_KEY: "ambient", OPENROUTER_API_KEY: "ambient" }, "paperclip/gpt-6-sol", 0), usage, usageBasis: "per_run" as const, complete: true };
    expect(receipt).toMatchObject({ biller: "unknown", billingType: "metered_api", costUsd: null, model: "gpt-6-sol" });
    expect(priceCodexReceipt(receipt)).toBe(receipt);
  });
  it("keeps no-auth/local costs unknown and OpenRouter outside direct prices", () => {
    expect(resolveOpenCodeAccounting({ kind: "local", auth: "none", baseUrl: "http://localhost:1234/v1" }, {}, "paperclip/local", 0)).toMatchObject({ biller: "unknown", billingType: "unknown", costUsd: null });
    expect(resolveOpenCodeAccounting({ kind: "openrouter", auth: "bearer" }, {}, "openrouter/openai/gpt-6-sol", 0)).toMatchObject({ biller: "openrouter", billingType: "metered_api", costUsd: null });
  });
  it("preserves ordinary client receipts and never prices unsupported models or incomplete work", () => {
    expect(resolveOpenCodeAccounting(undefined, { OPENAI_API_KEY: "fixture" }, "openai/gpt-6-sol", 0.25)).toMatchObject({ billingType: "metered_api", costUsd: 0.25, model: "openai/gpt-6-sol" });
    for (const override of [{ complete: false }, { model: "unsupported" }]) {
      const receipt = { ...resolveOpenCodeAccounting(direct, {}, "paperclip/gpt-6-sol", 0), usage, usageBasis: "per_run" as const, complete: true, ...override };
      expect(priceCodexReceipt(receipt)).toBe(receipt);
    }
  });
});
