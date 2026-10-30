import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isPerTurnRunProcess, observeRunProcesses, sameObservedProcess } from "./copilot-local-fixtures.js";
import { readLinuxProcessStartedAt } from "../../packages/paperclip-runner/src/live/linux-process-start.js";

describe("Copilot local process ownership", () => {
  it("retains the kernel birth identity across proc-directory timestamp changes", () => {
    const original = { pid: 100, parent: 1, start: "2026-10-08T01:18:30.820Z", bootId: "00000000-0000-0000-0000-000000000001", startTicks: "1000" };
    expect(sameObservedProcess(original, { ...original, start: "2026-10-08T01:18:32.000Z" })).toBe(true);
    for (const changed of [{ pid: 101 }, { startTicks: "1001" }, { bootId: "00000000-0000-0000-0000-000000000002" }, { startTicks: undefined }, { bootId: undefined }]) {
      expect(sameObservedProcess(original, { ...original, ...changed })).toBe(false);
    }
    expect(sameObservedProcess(undefined, original)).toBe(false);
  });
  it.skipIf(process.platform !== "linux")("captures the exact Linux process start identity published by the server", async () => {
    const runId = randomUUID();
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "--", "--run-id", runId, "--lifecycle-mode", "per_turn"], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      const pid = child.pid!;
      await new Promise(resolve => setTimeout(resolve, 1100));
      const startedAt = readLinuxProcessStartedAt(pid);
      const observer = observeRunProcesses();
      const authority = { pid, groupId: pid, startedAt, runId };
      const captured = observer.sample(authority);
      expect(captured.captured).toBe(true);
      expect(captured.live).toContain(pid);
      expect(observeRunProcesses().sample({ ...authority, startedAt: new Date(Date.parse(startedAt) + 1).toISOString() }).captured).toBe(false);
      child.kill("SIGTERM"); await exited;
      expect(observer.sample(authority).live).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  it("rejects a different millisecond in the Linux authority instead of rounding it to seconds", () => {
    const start = "2026-10-08T01:02:58.051Z";
    const authority = { pid: 100, groupId: 100, startedAt: start, runId: "owned-run" };
    const observed = { pid: 100, parent: 1, start };
    const command = "/owned/runner --run-id owned-run --lifecycle-mode per_turn";
    expect(isPerTurnRunProcess(authority, observed, command)).toBe(true);
    expect(isPerTurnRunProcess({ ...authority, startedAt: "2026-10-08T01:02:58.052Z" }, observed, command)).toBe(false);
  });
});
