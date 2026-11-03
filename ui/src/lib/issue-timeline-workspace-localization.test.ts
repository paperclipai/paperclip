import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { formatTimelineWorkspaceLabel, timelineWorkspaceLabelDisplay, type IssueTimelineWorkspace } from "./issue-timeline-events";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("timeline workspace display boundary", () => {
  const empty: IssueTimelineWorkspace = { label: null, projectWorkspaceId: null, executionWorkspaceId: null, mode: null };

  it("translates an absent workspace at read time without changing canonical data", async () => {
    const original = structuredClone(empty);
    expect(timelineWorkspaceLabelDisplay(empty)).toBe("None");
    await i18n.changeLanguage("ru");
    expect(timelineWorkspaceLabelDisplay(empty)).toBe("Нет");
    expect(formatTimelineWorkspaceLabel(empty)).toBe("None");
    expect(empty).toEqual(original);
    await i18n.changeLanguage("en");
    expect(timelineWorkspaceLabelDisplay(empty)).toBe("None");
  });

  it.each(["None", "My workspace", ""])("preserves the saved label %j", async label => {
    await i18n.changeLanguage("ru");
    expect(timelineWorkspaceLabelDisplay({ ...empty, label })).toBe(label);
  });

  it.each(["executionWorkspaceId", "projectWorkspaceId"] as const)("preserves the %s fallback identifier", async field => {
    await i18n.changeLanguage("ru");
    expect(timelineWorkspaceLabelDisplay({ ...empty, [field]: "raw-id-12345678" })).toBe("raw-id-1");
  });
});
