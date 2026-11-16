import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DifficultyRoutingConfig } from "@paperclipai/shared";
import {
  buildDifficultyCliCommand, buildDifficultyCliPrompt, classifyDifficultyByRules, createAgentCliClassifier, difficultyCliHarness,
  difficultyCliModel, parseDifficultyTier, readDifficultyCliAnswer, runDifficultyCli, type WithDifficultyCliCredentials,
} from "../services/heartbeat/difficulty-classifiers.js";

const config: DifficultyRoutingConfig = { enabled: true, tiers: { L1: { model: "gpt-cheap", effort: "low" }, L3: { model: "gpt-max" } } };

describe("rules classifier", () => {
  it.each([
    ["What is the status of the release?", null, "L1"],
    ["修一个错别字", null, "L1"],
    ["服务现在是什么状态？", null, "L1"],
    ["Write release notes for the billing page", "Use the changes in src/billing.ts and the open PR.", "L2"],
    ["Add a CSV export button to the reports page", "Include the date range filter and column headers.", "L2"],
    ["Redesign the cache layer across multiple services", null, "L3"],
    ["设计一个跨模块的缓存方案并评估风险", null, "L3"],
    ["排查登录偶发失败的根因", null, "L3"],
    ["Update the docs", "x".repeat(2500), "L3"],
  ])("rates %s as %s", (title, description, tier) => {
    expect(classifyDifficultyByRules({ title, description })).toBe(tier);
  });
});

describe("subscription CLI classifier", () => {
  it("parses only a tier token", () => {
    expect(parseDifficultyTier("L2")).toBe("L2");
    expect(parseDifficultyTier("Tier: L3.")).toBe("L3");
    expect(parseDifficultyTier("L4")).toBeNull();
    expect(parseDifficultyTier(null)).toBeNull();
    const jsonl = [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "L1" } }), JSON.stringify({ type: "turn.completed", usage: {} })].join("\n");
    expect(readDifficultyCliAnswer("codex", jsonl)).toBe("L1");
    expect(readDifficultyCliAnswer("claude", "L3\n")).toBe("L3");
  });

  it("keeps the task text inside the prompt as data and bounds its size", () => {
    const prompt = buildDifficultyCliPrompt({ title: "t".repeat(900), description: "d".repeat(9000) });
    expect(prompt).toContain("Reply with exactly one token: L1, L2, or L3.");
    expect(prompt).toContain("<task>");
    expect(prompt.length).toBeLessThan(6000);
  });

  it("supports Codex and Claude harnesses with the cheapest configured model", () => {
    expect(difficultyCliHarness({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } })).toBe("codex");
    expect(difficultyCliHarness({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude" } })).toBe("claude");
    expect(difficultyCliHarness({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "grok" } })).toBeNull();
    expect(difficultyCliHarness({ adapterType: "claude_local", adapterConfig: {} })).toBe("claude");
    expect(difficultyCliModel({ adapterType: "codex_local", adapterConfig: { model: "gpt-main" } }, config)).toBe("gpt-cheap");
    expect(difficultyCliModel({ adapterType: "codex_local", adapterConfig: { model: "gpt-main" } }, { enabled: true, tiers: {} })).toBe("gpt-main");
    expect(buildDifficultyCliCommand("codex", "gpt-cheap").args).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--sandbox", "read-only", "-m", "gpt-cheap", 'model_reasoning_effort="low"']));
    expect(buildDifficultyCliCommand("claude", "haiku").args).toEqual(["--print", "-", "--output-format", "text", "--tools", "", "--model", "haiku"]);
  });

  it("returns no classifier for unsupported agents or disabled routing", () => {
    const withCredentials = vi.fn();
    expect(createAgentCliClassifier({ agent: { adapterType: "gemini_local", adapterConfig: {} }, config, withCredentials })).toBeNull();
    expect(createAgentCliClassifier({ agent: { adapterType: "codex_local", adapterConfig: {} }, config: null, withCredentials })).toBeNull();
  });

  describe("with a fake CLI on PATH", () => {
    let bin: string;
    let originalPath: string | undefined;
    beforeAll(async () => {
      bin = await mkdtemp(path.join(os.tmpdir(), "paperclip-difficulty-bin-"));
      // Records its environment and stdin, then answers like `claude --print`.
      await writeFile(path.join(bin, "claude"), `#!/bin/sh
env > "${bin}/env.txt"
cat > "${bin}/stdin.txt"
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
echo "\${FAKE_ANSWER:-L2}"
exit "\${FAKE_EXIT:-0}"
`);
      await chmod(path.join(bin, "claude"), 0o755);
      originalPath = process.env.PATH;
      process.env.PATH = `${bin}:${originalPath ?? ""}`;
      process.env.OPENAI_API_KEY = "host-key-must-not-leak";
    });
    afterAll(async () => {
      process.env.PATH = originalPath;
      delete process.env.OPENAI_API_KEY;
      await rm(bin, { recursive: true, force: true });
    });

    it("passes only PATH and the managed credential environment", async () => {
      expect(await runDifficultyCli({ harness: "claude", model: "haiku", env: { CLAUDE_CODE_OAUTH_TOKEN: "managed" }, prompt: "rate this" })).toBe("L2");
      const env = await readFile(path.join(bin, "env.txt"), "utf8");
      expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN=managed");
      expect(env).not.toContain("host-key-must-not-leak");
      expect(await readFile(path.join(bin, "stdin.txt"), "utf8")).toBe("rate this");
    });

    it("rejects on a failed exit and on timeout", async () => {
      await expect(runDifficultyCli({ harness: "claude", model: null, env: { FAKE_EXIT: "3" }, prompt: "x" })).rejects.toThrow("exited with 3");
      await expect(runDifficultyCli({ harness: "claude", model: null, env: { FAKE_SLEEP: "5" }, prompt: "x", timeoutMs: 200 })).rejects.toThrow();
    });

    it("rejects when the run is cancelled", async () => {
      const controller = new AbortController();
      const pending = runDifficultyCli({ harness: "claude", model: null, env: { FAKE_SLEEP: "5" }, prompt: "x", signal: controller.signal });
      setTimeout(() => controller.abort(new Error("run cancelled")), 100);
      await expect(pending).rejects.toThrow("run cancelled");
    });

    it("classifies through the credential callback", async () => {
      let calls = 0;
      const withCredentials: WithDifficultyCliCredentials = async (use) => { calls += 1; return use({ FAKE_ANSWER: "L3" }); };
      const classify = createAgentCliClassifier({ agent: { adapterType: "claude_local", adapterConfig: {} }, config, withCredentials })!;
      expect(await classify({ title: "Design the plugin API", description: null })).toBe("L3");
      expect(calls).toBe(1);
    });
  });
});
