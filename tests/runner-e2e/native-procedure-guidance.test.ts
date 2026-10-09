import { describe, expect, it } from "vitest";
import { runnerMatrix, runnerSuites } from "./catalog.js";
import { everydayTasks } from "./everyday-cases.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

describe("bounded native procedure comparison", () => {
  const suite = runnerSuites.find(suite => suite.id === "everyday-workflows")!;
  it("selects only two original journeys on three native profiles, with no automatic retry", () => {
    expect(suite.manualOnly).toBe(true);
    const selected = selectRunnerExecutions(parseRunnerSelectors(["--suite", suite.id,
      "--profile", "runner-codex", "--profile", "runner-acpx-claude", "--profile", "runner-opencode",
      "--case", "hire-reuse", "--case", "delegate-feedback", "--environment", "local"]));
    expect(selected).toHaveLength(6);
    for (const { task } of selected) {
      const original = everydayTasks.find(candidate => candidate.id === task.id)!;
      expect(task).toEqual({ ...original, automaticRetryPolicy: "single_attempt" });
      expect(task.buildPrompt("nonce")).toBe(original.buildPrompt("nonce"));
      expect(task.attemptTimeoutMs.local).toBe(720_000);
    }
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"]), runnerMatrix).some(cell => cell.suite.id === suite.id)).toBe(false);
  });
  it("keeps procedure and completion directions out of the fixture persona", () => {
    for (const profile of suite.profiles) {
      const input = { executionId: "random-nonce", environmentId: "env", environmentFixtureId: "local" as const, workspacePath: "/workspace", secretRefs: {
        [profile.credential]: { type: "secret_ref" as const, secretId: "00000000-0000-4000-8000-000000000001", version: "latest" as const },
      } };
      const agent = profile.buildAgent(input);
      expect(JSON.stringify(agent.instructionsBundle)).not.toMatch(/paperclip_finish|paperclip_block|set_dependencies|hire_agent/);
    }
  });
});
