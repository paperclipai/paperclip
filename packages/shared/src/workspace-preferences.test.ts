import { describe, expect, it } from "vitest";
import { updateWorkspacePreferenceSchema } from "./workspace-preferences.js";

describe("personal Recents limit", () => {
  it.each([0, 5, 10, 20, 50, 100])("accepts a limit of %s without other preferences", recentItemsLimit => {
    expect(updateWorkspacePreferenceSchema.parse({ recentItemsLimit })).toEqual({ recentItemsLimit });
  });
  it.each([-1, 1, 13, 101, 1.5, "20", null])("rejects invalid limit %s", recentItemsLimit => {
    expect(updateWorkspacePreferenceSchema.safeParse({ recentItemsLimit }).success).toBe(false);
  });
});
