import { describe, expect, it } from "vitest";
import {
  computeLocalRunAdmissionSlots,
  isLocalModelRun,
  parseModelProvider,
  resolveLocalRunCaps,
  withLocalRunAdmissionLock,
  type LocalRunCaps,
} from "./local-run-concurrency.js";

const caps: LocalRunCaps = {
  maxConcurrentRuns: 4,
  maxDistinctModels: 2,
  localModelProviders: ["dev"],
};

describe("parseModelProvider", () => {
  it("extracts the provider segment before the first slash", () => {
    expect(parseModelProvider("dev/qwen3.6:35b")).toBe("dev");
    expect(parseModelProvider("dev/Alieno/ailo-152m-v2:152m")).toBe("dev");
    expect(parseModelProvider("github-copilot/claude-opus-4.8-fast")).toBe("github-copilot");
  });

  it("returns null when there is no provider prefix", () => {
    expect(parseModelProvider("qwen3.6:35b")).toBeNull();
    expect(parseModelProvider("/leading-slash")).toBeNull();
    expect(parseModelProvider("")).toBeNull();
    expect(parseModelProvider(null)).toBeNull();
    expect(parseModelProvider(undefined)).toBeNull();
  });
});

describe("isLocalModelRun", () => {
  it("counts Ollama-backed opencode_local runs", () => {
    expect(isLocalModelRun("opencode_local", "dev/qwen3.6:35b", caps)).toBe(true);
  });

  it("exempts cloud-backed opencode_local runs", () => {
    expect(isLocalModelRun("opencode_local", "github-copilot/claude-opus-4.8-fast", caps)).toBe(false);
  });

  it("exempts non-opencode_local adapters", () => {
    expect(isLocalModelRun("codex_local", "dev/qwen3.6:35b", caps)).toBe(false);
    expect(isLocalModelRun("claude_local", "dev/qwen3.6:35b", caps)).toBe(false);
  });

  it("honors a custom local provider list", () => {
    const custom = { localModelProviders: ["ollama", "dev"] };
    expect(isLocalModelRun("opencode_local", "ollama/llama3", custom)).toBe(true);
  });
});

describe("computeLocalRunAdmissionSlots", () => {
  it("bounds slots by the global concurrency cap", () => {
    const slots = computeLocalRunAdmissionSlots({
      state: { runningCount: 3, loadedModels: new Set(["dev/a"]) },
      agentModel: "dev/a",
      perAgentSlots: 10,
      caps,
    });
    // cap is 4, 3 running -> only 1 slot left
    expect(slots).toBe(1);
  });

  it("never exceeds the per-agent slot budget", () => {
    const slots = computeLocalRunAdmissionSlots({
      state: { runningCount: 0, loadedModels: new Set() },
      agentModel: "dev/a",
      perAgentSlots: 2,
      caps,
    });
    expect(slots).toBe(2);
  });

  it("returns 0 when the global concurrency cap is already reached", () => {
    const slots = computeLocalRunAdmissionSlots({
      state: { runningCount: 4, loadedModels: new Set(["dev/a", "dev/b"]) },
      agentModel: "dev/a",
      perAgentSlots: 5,
      caps,
    });
    expect(slots).toBe(0);
  });

  it("admits an already-loaded model even at the distinct-model ceiling", () => {
    const slots = computeLocalRunAdmissionSlots({
      state: { runningCount: 2, loadedModels: new Set(["dev/a", "dev/b"]) },
      agentModel: "dev/a",
      perAgentSlots: 5,
      caps,
    });
    // model already loaded; concurrency 4-2 = 2 slots
    expect(slots).toBe(2);
  });

  it("blocks a new model once the distinct-model ceiling is reached", () => {
    const slots = computeLocalRunAdmissionSlots({
      state: { runningCount: 2, loadedModels: new Set(["dev/a", "dev/b"]) },
      agentModel: "dev/c",
      perAgentSlots: 5,
      caps,
    });
    expect(slots).toBe(0);
  });

  it("admits a new model when a model slot is still free", () => {
    const slots = computeLocalRunAdmissionSlots({
      state: { runningCount: 1, loadedModels: new Set(["dev/a"]) },
      agentModel: "dev/b",
      perAgentSlots: 5,
      caps,
    });
    // distinct models would become 2 (== ceiling) which is allowed;
    // concurrency 4-1 = 3 slots
    expect(slots).toBe(3);
  });
});

describe("resolveLocalRunCaps", () => {
  it("falls back to defaults when env is unset", () => {
    const resolved = resolveLocalRunCaps({});
    expect(resolved.maxConcurrentRuns).toBe(4);
    expect(resolved.maxDistinctModels).toBe(2);
    expect(resolved.localModelProviders).toEqual(["dev"]);
  });

  it("reads overrides from the environment", () => {
    const resolved = resolveLocalRunCaps({
      PAPERCLIP_MAX_CONCURRENT_LOCAL_RUNS: "6",
      PAPERCLIP_MAX_DISTINCT_LOCAL_MODELS: "3",
      PAPERCLIP_LOCAL_MODEL_PROVIDERS: "dev, ollama",
    } as NodeJS.ProcessEnv);
    expect(resolved.maxConcurrentRuns).toBe(6);
    expect(resolved.maxDistinctModels).toBe(3);
    expect(resolved.localModelProviders).toEqual(["dev", "ollama"]);
  });

  it("ignores invalid numeric overrides and keeps defaults", () => {
    const resolved = resolveLocalRunCaps({
      PAPERCLIP_MAX_CONCURRENT_LOCAL_RUNS: "0",
      PAPERCLIP_MAX_DISTINCT_LOCAL_MODELS: "not-a-number",
    } as NodeJS.ProcessEnv);
    expect(resolved.maxConcurrentRuns).toBe(4);
    expect(resolved.maxDistinctModels).toBe(2);
  });
});

describe("withLocalRunAdmissionLock", () => {
  it("serializes overlapping critical sections", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstInside = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withLocalRunAdmissionLock(async () => {
      events.push("first:start");
      await firstInside;
      events.push("first:end");
    });

    const second = withLocalRunAdmissionLock(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    // Give the event loop a chance; second must not start while first holds the lock.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});
