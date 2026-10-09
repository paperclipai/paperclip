import { describe, expect, it } from "vitest";
import { resolveCombinedInboxTasksEnabled } from "./useCombinedInboxTasksEnabled";

describe("resolveCombinedInboxTasksEnabled", () => {
  it("is on only when opted in", () => {
    expect(resolveCombinedInboxTasksEnabled({ enableCombinedInboxTasks: true })).toBe(true);
    expect(resolveCombinedInboxTasksEnabled({ enableCombinedInboxTasks: false })).toBe(false);
    expect(resolveCombinedInboxTasksEnabled(undefined)).toBe(false);
  });

  it("stays off in the legacy shell, which has no merged Tasks page", () => {
    expect(resolveCombinedInboxTasksEnabled({ enableCombinedInboxTasks: true, enableStreamlinedUi: false })).toBe(false);
  });
});
