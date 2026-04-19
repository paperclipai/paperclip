import { describe, expect, it } from "vitest";
import { activityService } from "../services/activity.js";

describe("services/activity.ts", () => {
  it("exposes activity service methods", () => {
    const service = activityService({} as any);
    expect(service).toMatchObject({
      list: expect.any(Function),
      forIssue: expect.any(Function),
      runsForIssue: expect.any(Function),
      issuesForRun: expect.any(Function),
      create: expect.any(Function),
    });
  });
});

