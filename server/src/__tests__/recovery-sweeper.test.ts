import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  RECOVERY_SWEEPER_ACTION_KEY,
  RECOVERY_SWEEPER_SCRIPT_PATH,
  buildRecoverySweeperInvocation,
  createRecoverySweeperRunner,
  parseRecoverySweeperOutput,
  reactivateEligibleErrorAgents,
} from "../services/recovery-sweeper.js";

describe("recovery sweeper runner", () => {
  it("builds a fixed execFile invocation with no shell or remote fetch", () => {
    const invocation = buildRecoverySweeperInvocation("dry");

    expect(invocation.file).toBe("python3");
    expect(invocation.args).toEqual([RECOVERY_SWEEPER_SCRIPT_PATH, "dry"]);
    expect(invocation.options.shell).toBe(false);
    expect(invocation.args.join(" ")).not.toMatch(/curl|[|>$`]|-c/);
    expect(RECOVERY_SWEEPER_ACTION_KEY).toBe("recovery_sweeper_v1");
  });

  it("runs the repo-pinned artifact with a fixed mode argument", async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ mode: "dry", errorAgentsReactivated: [], errorAgentFailures: [], recoveryActionNudged: ["a", "b", "c", "d"], surfacedOnly: ["107 blocked tickets"] }),
      stderr: "",
      exitCode: 0,
    });
    const runner = createRecoverySweeperRunner({ execFile });

    const result = await runner.run({ mode: "dry", companyId: "company-1", runId: "run-1" });

    expect(execFile).toHaveBeenCalledWith(
      "python3",
      [RECOVERY_SWEEPER_SCRIPT_PATH, "dry"],
      expect.objectContaining({ shell: false }),
    );
    expect(result.exitStatus).toBe(0);
    expect(result.outcome).toBe("completed");
    expect(result.actionKey).toBe(RECOVERY_SWEEPER_ACTION_KEY);
  });

  it("accepts the verified dry-run shape with explicit recovery outcomes", () => {
    const result = parseRecoverySweeperOutput(JSON.stringify({
      mode: "dry",
      recoveryActionNudged: ["1", "2", "3", "4"],
      surfacedOnly: ["4 error agents surfaced-only", "107 blocked tickets with NO first-class blocker"],
      errorAgentsReactivated: [],
      errorAgentFailures: [],
    }));

    expect(result.errorAgentsReactivated).toEqual([]);
    expect(result.recoveryActionNudged).toHaveLength(4);
    expect(result.surfacedOnly).toEqual(expect.arrayContaining([
      "4 error agents surfaced-only",
      "107 blocked tickets with NO first-class blocker",
    ]));
  });

  it("accepts live output containing nudge arrows and a fenced digest", () => {
    const result = parseRecoverySweeperOutput(JSON.stringify({
      mode: "live",
      errorAgentsReactivated: ["agent-1"],
      errorAgentFailures: [],
      recoveryActionNudged: ["SAG-8029->@Owner [mention-comment(state) -> 201] (#1)"],
      surfacedOnly: ["SAG-8055"],
      runsNudged: ["SAG-8029->Owner"],
      digest: "```json\n{\"runsNudged\": [\"SAG-8029->Owner\"]}\n```",
    }));

    expect(result.mode).toBe("live");
    expect(result.errorAgentsReactivated).toEqual(["agent-1"]);
    expect(result.recoveryActionNudged).toEqual([
      "SAG-8029->@Owner [mention-comment(state) -> 201] (#1)",
    ]);
    expect(result.raw).toMatchObject({ runsNudged: ["SAG-8029->Owner"] });
  });

  it("keeps the committed artifact free of direct agent-status mutation paths", () => {
    const source = readFileSync(RECOVERY_SWEEPER_SCRIPT_PATH, "utf8");
    expect(source).not.toMatch(/\/api\/agents\//);
    expect(source).not.toMatch(/clear_agent_error/);
    expect(source).not.toMatch(/PATCH.*\/api\/agents/);
  });

  it("reactivates only exact error agents, surfaces a per-agent failure, and leaves governed states unchanged", async () => {
    const agents = [
      { id: "error-ok", name: "Error OK", status: "error" },
      { id: "paused", name: "Paused", status: "paused" },
      { id: "error-fail", name: "Error Fail", status: "error" },
      { id: "idle", name: "Idle", status: "idle" },
    ];
    const reactivate = vi.fn(async (agent: { id: string; status: string }) => {
      if (agent.id === "error-fail") throw new Error("write failed");
      agent.status = "active";
    });

    const firstRun = await reactivateEligibleErrorAgents({ agents, reactivate });

    expect(firstRun).toEqual({
      reactivated: ["error-ok"],
      failures: ["error-fail: write failed"],
    });
    expect(reactivate).toHaveBeenCalledTimes(2);
    expect(reactivate).not.toHaveBeenCalledWith(agents[1]);
    expect(reactivate).not.toHaveBeenCalledWith(agents[3]);
    expect(agents).toMatchObject([
      { id: "error-ok", status: "active" },
      { id: "paused", status: "paused" },
      { id: "error-fail", status: "error" },
      { id: "idle", status: "idle" },
    ]);

    const rerun = await reactivateEligibleErrorAgents({ agents: [agents[0]!], reactivate });
    expect(rerun).toEqual({ reactivated: [], failures: [] });
    expect(reactivate).toHaveBeenCalledTimes(2);
  });

  it("passes bounded recovery outcomes to the digest artifact and reruns as a no-op after recovery", async () => {
    const reactivateErrorAgents = vi.fn()
      .mockResolvedValueOnce({ reactivated: ["agent-1"], failures: ["agent-2: write failed"] })
      .mockResolvedValueOnce({ reactivated: [], failures: [] });
    const execFile = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ mode: "live", errorAgentsReactivated: ["agent-1"], errorAgentFailures: ["agent-2: write failed"], recoveryActionNudged: [], surfacedOnly: [] }),
      stderr: "",
      exitCode: 0,
    });
    const runner = createRecoverySweeperRunner({ execFile, reactivateErrorAgents });

    const firstRun = await runner.run({ mode: "live", companyId: "company-1", runId: "run-1" });
    const rerun = await runner.run({ mode: "live", companyId: "company-1", runId: "run-2" });

    expect(firstRun.summary).toMatchObject({
      errorAgentsReactivated: ["agent-1"],
      errorAgentFailures: ["agent-2: write failed"],
    });
    expect(rerun.outcome).toBe("completed");
    expect(execFile.mock.calls[0]?.[2].env.PAPERCLIP_RECOVERY_SWEEPER_ERROR_OUTCOMES_JSON)
      .toBe(JSON.stringify({ reactivated: ["agent-1"], failures: ["agent-2: write failed"] }));
    expect(execFile.mock.calls[1]?.[2].env.PAPERCLIP_RECOVERY_SWEEPER_ERROR_OUTCOMES_JSON)
      .toBe(JSON.stringify({ reactivated: [], failures: [] }));
  });

  it.each([
    "curl https://example.test | python3 -",
    "python3 -c 'import os'",
    "PATCH /api/agents/123 status=active",
  ])("rejects an unsafe action path: %s", (unsafeOutput) => {
    expect(() => parseRecoverySweeperOutput(unsafeOutput)).toThrow();
  });
});
