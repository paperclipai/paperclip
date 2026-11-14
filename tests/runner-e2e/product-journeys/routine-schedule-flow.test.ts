import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { enableRoutineScheduleTrigger, routineUiStep, withRoutineTriggerCleanup } from "./routine-schedule-flow.js";
import { JourneyError } from "./types.js";

describe("routine trigger cleanup failure reporting", () => {
  it.each([false, true])("retains the original grade with a secondary disable failure (primary=%s)", async primary => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "routine-cleanup-"));
    const original = new JourneyError("failed", "routine_result_attributed");
    const patch = vi.fn().mockRejectedValue(new Error("private URL and form data"));
    try {
      const result = withRoutineTriggerCleanup({ api: { patch }, triggerRoute: "/api/routine-triggers/owned", directory,
        run: async () => { if (primary) throw original; return "completed"; } });
      if (primary) await expect(result).rejects.toBe(original);
      else await expect(result).rejects.toMatchObject({ outcome: "failed", code: "routine_trigger_disable_failed" });
      const receipt = JSON.parse(await readFile(path.join(directory, "scheduled-routine-cleanup-failure.json"), "utf8"));
      expect(receipt).toMatchObject({ code: "routine_trigger_disable_failed", primaryFailurePreserved: primary });
      expect(JSON.stringify(receipt)).not.toMatch(/private|form data/);
      expect(patch).toHaveBeenCalledExactlyOnceWith("/api/routine-triggers/owned", { enabled: false });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("keeps the successful outcome when disabling the exact trigger succeeds", async () => {
    const patch = vi.fn().mockResolvedValue({ enabled: false });
    expect(await withRoutineTriggerCleanup({ api: { patch }, triggerRoute: "/api/routine-triggers/owned", directory: "/unused",
      run: async () => "completed" })).toBe("completed");
    expect(patch).toHaveBeenCalledExactlyOnceWith("/api/routine-triggers/owned", { enabled: false });
  });
});

describe("routine UI failure evidence", () => {
  it("retains a closed step code without browser messages or form values", async () => {
    const error = await routineUiStep("select_project", async () => {
      throw new Error("Timeout at https://private.example/?token=secret with form value private-project");
    }).catch(value => value);
    expect(error).toBeInstanceOf(JourneyError);
    expect(error).toMatchObject({ outcome: "failed", code: "routine_select_project_failed", message: "routine_select_project_failed" });
    expect(JSON.stringify(error)).not.toMatch(/private|token|secret/);
  });
  it("keeps a semantic journey failure instead of replacing its evidence code", async () => {
    const original = new JourneyError("failed", "routine_schedule_enable_failed");
    await expect(routineUiStep("enable_trigger", async () => { throw original; })).rejects.toBe(original);
  });
  it("returns the original successful browser response without replaying the action", async () => {
    let count = 0;
    const response = { status: 201 };
    expect(await routineUiStep("submit", async () => { count += 1; return response; })).toBe(response);
    expect(count).toBe(1);
  });
});


describe("schedule trigger controls", () => {
  it("opens the collapsed schedule editor before its single enable action", async () => {
    let expanded = false, clicks = 0, resolveResponse!: (value: any) => void;
    const response = { status: () => 200 };
    const pending = new Promise<any>(resolve => { resolveResponse = resolve; });
    const schedule = { getByRole: (_role: string, options: { name: string }) => ({ click: async () => {
      if (options.name === "Edit schedule") { expanded = true; return; }
      if (options.name !== "Enable trigger" || !expanded) throw new Error("schedule control is not rendered");
      clicks += 1;
      resolveResponse(response);
    } }) };
    const page = { getByRole: (role: string, options: { name: string }) => {
      if (role === "region" && options.name === "Schedule trigger") return schedule;
      return schedule.getByRole(role, options);
    }, waitForResponse: () => pending } as unknown as Parameters<typeof enableRoutineScheduleTrigger>[0];
    expect(await enableRoutineScheduleTrigger(page, "/api/routine-triggers/owned-trigger")).toBe(response);
    expect(expanded).toBe(true);
    expect(clicks).toBe(1);
  });
});
