import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { controllerLogNames, gradeWarmShutdown, isWarmWave, waitBounded, warmShutdownMarkdown, watchFirstIdleCloseFailure } from "./warm-shutdown.js";

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
    expect(check.shutdownCloseFailures).toEqual([{ runId: null, lines: 1,
      reason: 'WARN: idle native session cleanup failed before controller shutdown {"idleSessions":{"failed":2}}',
      firstLine: '[14:20:17] WARN: idle native session cleanup failed before controller shutdown {"idleSessions":{"failed":2}}' }]);
    expect(check.problems).toHaveLength(3);
    expect(warmShutdownMarkdown(check)).toContain("Verdict: FAIL");
  });

  it("reports a forced stop without failing when cleanup still finished", () => {
    const check = gradeWarmShutdown({ cleanup: clean,
      serverLog: "WARN: warm native session close did not settle; its Runner was stopped and the session discarded {}\n" });
    expect(check).toMatchObject({ verdict: "pass", idleCloseFailures: [{ firstLine: expect.stringContaining("did not settle") }] });
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

  const a1Log = readFileSync(path.join(import.meta.dirname, "fixtures/a1-warm-close-failures.log"), "utf8");
  const run300 = "300f0d61-548b-4630-8f6a-f79292ed9d24";
  const run70d = "70d909cc-8b04-40ae-a0bf-0846df140cf0";

  it("reports each distinct (run, reason) once, not each log line (w-20261116T001158-s7106 A1: 2 sessions, 29 lines)", () => {
    expect(a1Log.split("\n").filter(line => /did not close|cleanup failed before controller shutdown/.test(line))).toHaveLength(29);
    const check = gradeWarmShutdown({ cleanup: clean, serverLog: a1Log });
    expect(check.verdict).toBe("fail");
    expect(check.shutdownCloseFailures.map(({ runId, lines }) => ({ runId, lines }))).toEqual([
      { runId: run300, lines: 2 }, { runId: run70d, lines: 27 }]);
    expect(check.shutdownCloseFailures[0]!.reason).toMatch(/process_identity_changed\]$/);
    expect(check.shutdownCloseFailures[1]!.reason).toBe(
      "close failed: native_session_close_unrecoverable: provider_transport_failed: runner did not durably suspend before checkpoint");
    expect(check.idleCloseFailures.map(({ runId, lines }) => ({ runId, lines }))).toEqual([
      { runId: run300, lines: 4 }, { runId: run70d, lines: 1 }]);
    expect(check.problems).toHaveLength(2);
    expect(warmShutdownMarkdown(check)).toContain("warm sessions that did not close: 2; idle closes that needed a forced stop or failed: 2.");
  });

  it("still fails on one distinct failure, and keeps different reasons for the same run apart", () => {
    const one = a1Log.split("\n").filter(line => line.includes(run70d) && line.includes("did not close"));
    expect(gradeWarmShutdown({ cleanup: clean, serverLog: one.join("\n") })).toMatchObject({ verdict: "fail",
      shutdownCloseFailures: [{ runId: run70d, lines: 27 }] });
    const twoReasons = [
      'WARN: idle warm native sessions did not close {"reason":"controller restart","failures":[{"runId":"r1","reason":"close failed: a"}]}',
      'WARN: idle warm native sessions did not close {"reason":"controller restart","failures":[{"runId":"r1","reason":"close failed: b"}]}',
    ].join("\n");
    expect(gradeWarmShutdown({ cleanup: clean, serverLog: twoReasons }).problems).toHaveLength(2);
    const unparsed = gradeWarmShutdown({ cleanup: clean, serverLog: 'WARN: idle warm native sessions did not close {"reason":"environment deleted","failures":[' });
    expect(unparsed).toMatchObject({ verdict: "fail", shutdownCloseFailures: [{ runId: null, lines: 1 }] });
  });

  it("names the first idle-close failure once, across chunk boundaries and interleaved streams", () => {
    const seen: Array<{ runId: string | null }> = [];
    const watch = watchFirstIdleCloseFailure(failure => { seen.push(failure); });
    const failed = a1Log.split("\n").find(line => line.includes("idle warm native session close failed") && line.includes(run70d))!;
    watch("INFO: server ready\n", "1:stdout");
    watch(failed.slice(0, 40), "1:stdout");
    watch("WARN: unrelated stderr line\n", "1:stderr");
    expect(seen).toEqual([]);
    watch(`${failed.slice(40)}\n`, "1:stdout");
    watch(`${failed}\n`, "1:stdout");
    expect(seen).toEqual([expect.objectContaining({ runId: run70d })]);
    const quiet: unknown[] = [];
    const none = watchFirstIdleCloseFailure(failure => { quiet.push(failure); });
    none("WARN: warm native session close did not settle; its Runner was stopped and the session discarded {}\n");
    expect(quiet).toEqual([]);
  });

  it("lists the sandbox captures taken at the first idle-close failure", () => {
    const check = gradeWarmShutdown({ cleanup: clean, serverLog: a1Log, sandboxCaptures: ["idle-close-failure-300f0d61"] });
    expect(check.sandboxCaptures).toEqual(["idle-close-failure-300f0d61"]);
    expect(warmShutdownMarkdown(check)).toContain("idle-close-failure-300f0d61");
  });

  it("waits for a pending capture only up to its bound", async () => {
    expect(await waitBounded(() => null, 10)).toBe("none");
    expect(await waitBounded(() => Promise.resolve(), 1_000)).toBe("settled");
    expect(await waitBounded(() => Promise.reject(new Error("probe failed")), 1_000)).toBe("settled");
    expect(await waitBounded(() => new Promise(() => undefined), 20)).toBe("timed_out");
  });
});
