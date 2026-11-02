import { describe, expect, it } from "vitest";
import { routineUiStep } from "./routine-schedule-flow.js";
import { JourneyError } from "./types.js";

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
