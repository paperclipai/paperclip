import { describe, expect, it } from "vitest";
import { resetAgentSessionSchema, updateAgentSchema } from "./agent.js";

describe("agent update schema", () => {
  it.each(["paused", "idle", "terminated"])("accepts lifecycle status request %s", status => {
    expect(updateAgentSchema.parse({ status })).toEqual({ status });
  });
  it.each(["active", "running", "error", "pending_approval"])("rejects direct status write %s", status => {
    const result = updateAgentSchema.safeParse({ name: "Renamed", status });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["status"] }),
    ]));
  });
  it.each([{ spentMonthlyCents: 0 }, { name: "Renamed", spentMonthlyCents: 10 }])("rejects spend totals: %j", payload => {
    const result = updateAgentSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["spentMonthlyCents"] }),
    ]));
  });
  it("accepts profile and budget limit changes", () => {
    expect(updateAgentSchema.parse({ name: "Renamed", budgetMonthlyCents: 100 })).toEqual({ name: "Renamed", budgetMonthlyCents: 100 });
  });
});

describe("reset agent session schema", () => {
  it.each([{}, { taskKey: null }])("accepts a full reset request: %j", payload => {
    expect(resetAgentSessionSchema.parse(payload)).toEqual(payload);
  });
  it("trims a task key", () => {
    expect(resetAgentSessionSchema.parse({ taskKey: "  task-1  " })).toEqual({ taskKey: "task-1" });
  });
  it.each(["", "   ", "\t\n"])("rejects a blank task key %j", taskKey => {
    const result = resetAgentSessionSchema.safeParse({ taskKey });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["taskKey"] }),
    ]));
  });
});
