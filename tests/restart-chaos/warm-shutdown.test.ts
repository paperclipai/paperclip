import { describe, expect, it } from "vitest";
import { controllerLogNames, gradeWarmShutdown, isWarmWave, warmShutdownMarkdown } from "./warm-shutdown.js";

const esc = String.fromCharCode(27);
const clean = { environmentDeleted: true, environmentDeleteBlocked: null, remainingSandboxes: [] };

describe("clean warm shutdown check", () => {
  it("applies to warm local and warm Daytona waves only", () => {
    expect(isWarmWave({ lifecycle: "warm" })).toBe(true);
    expect(isWarmWave({ daytonaWarm: true })).toBe(true);
    expect(isWarmWave({ lifecycle: "per_turn" })).toBe(false);
    expect(isWarmWave({})).toBe(false);
  });

  it("grades every controller's log, including the second controller of a multi-server wave", () => {
    expect(controllerLogNames(["timeline.jsonl", "server-b.log", "server.log", "speed.json", "server.log.bak"]))
      .toEqual(["server-b.log", "server.log"]);
  });

  it("passes a deleted environment with no sandboxes left and no unclosed session", () => {
    const check = gradeWarmShutdown({ cleanup: clean, serverLog: `[14:20:17] ${esc}[32mINFO${esc}[39m: server stopped\n` });
    expect(check).toMatchObject({ verdict: "pass", problems: [], leakedSandboxes: [] });
  });

  it("fails the staging shape: a 409 delete, started sandboxes and a bare failed count at shutdown", () => {
    const blocked = "DELETE /api/environments/env?destroyReusableSandboxLeases=true returned 409: warm native runner did not shut down cleanly";
    const check = gradeWarmShutdown({
      cleanup: { environmentDeleted: false, environmentDeleteBlocked: blocked, remainingSandboxes: ["sbx-1:started", "sbx-2:started"] },
      serverLog: `[14:20:17] ${esc}[33mWARN${esc}[39m: ${esc}[36midle native session cleanup failed before controller shutdown${esc}[39m {"idleSessions":{"failed":2}}\n`,
    });
    expect(check.verdict).toBe("fail");
    expect(check.environmentDeleteBlocked).toBe(blocked);
    expect(check.leakedSandboxes).toEqual(["sbx-1:started", "sbx-2:started"]);
    expect(check.shutdownCloseFailures).toEqual(['[14:20:17] WARN: idle native session cleanup failed before controller shutdown {"idleSessions":{"failed":2}}']);
    expect(check.problems).toHaveLength(3);
    expect(warmShutdownMarkdown(check)).toContain("Verdict: FAIL");
  });

  it("reports a forced stop without failing when cleanup still finished", () => {
    const check = gradeWarmShutdown({ cleanup: clean,
      serverLog: "WARN: warm native session close did not settle; its Runner was stopped and the session discarded {}\n" });
    expect(check).toMatchObject({ verdict: "pass", idleCloseFailures: [expect.stringContaining("did not settle")] });
    expect(gradeWarmShutdown({ cleanup: clean,
      serverLog: "WARN: warm native session's sandbox was already destroyed; released its owner {}\n" }).idleCloseFailures).toHaveLength(1);
  });

  it("grades a warm local wave from the server log alone", () => {
    expect(gradeWarmShutdown({ cleanup: null, serverLog: "" }).verdict).toBe("pass");
    expect(gradeWarmShutdown({ cleanup: null,
      serverLog: 'WARN: idle warm native sessions did not close {"reason":"controller restart","failures":[]}' }).verdict).toBe("fail");
    expect(gradeWarmShutdown({ cleanup: null,
      serverLog: 'WARN: idle warm native sessions did not close {"reason":"terminal heartbeat run destroyed its environment lease"}' }).verdict).toBe("pass");
  });
});
