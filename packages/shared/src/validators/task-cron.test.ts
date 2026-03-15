import { describe, expect, it } from "vitest";
import { createTaskCronScheduleSchema } from "./task-cron.js";

describe("createTaskCronScheduleSchema", () => {
  it("applies defaults for optional fields", () => {
    const parsed = createTaskCronScheduleSchema.parse({
      name: "Daily inbox triage",
      expression: "0 9 * * 1-5",
    });
    expect(parsed.timezone).toBe("UTC");
    expect(parsed.enabled).toBe(true);
    expect(parsed.issueMode).toBe("create_new");
  });

  it("accepts issue-linked schedule input", () => {
    const parsed = createTaskCronScheduleSchema.parse({
      name: "Repeat issue",
      expression: "0 * * * *",
      issueId: "11111111-1111-4111-8111-111111111111",
      issueMode: "reopen_existing",
    });
    expect(parsed.issueMode).toBe("reopen_existing");
    expect(parsed.issueId).toBe("11111111-1111-4111-8111-111111111111");
  });
});
