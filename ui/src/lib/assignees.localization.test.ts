import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import {
  currentUserAssigneeOption, currentUserAssigneeDisplayOptions, formatAssigneeUserLabel,
  formatAssigneeUserDisplayLabel, formatUserLabel, formatUserDisplayLabel, parseAssigneeValue,
} from "./assignees";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("assignee display labels", () => {
  it("updates retained display options without changing canonical metadata or selection IDs", async () => {
    await i18n.changeLanguage("en");
    const [option] = currentUserAssigneeDisplayOptions("local-board");
    expect(option.label).toBe("Me");
    await i18n.changeLanguage("ru");
    expect(option.label).toBe("Я");
    expect(option.searchText).toContain("me board human local-board");
    expect(option.searchText).toContain("я вы руководство человек");
    expect(option.id).toBe("user:local-board");
    expect(parseAssigneeValue(option.id)).toEqual({ assigneeAgentId: null, assigneeUserId: "local-board" });
    expect(currentUserAssigneeOption("local-board")[0].label).toBe("Me");
    expect(formatAssigneeUserLabel("user-1", "user-1")).toBe("You");
    expect(formatUserLabel("local-board")).toBe("Board");
    await i18n.changeLanguage("en");
    expect(option.label).toBe("Me");
  });

  it("translates only generated self/board labels and preserves supplied names verbatim", async () => {
    await i18n.changeLanguage("ru");
    expect(formatAssigneeUserDisplayLabel("user-1", "user-1")).toBe("Вы");
    expect(formatUserDisplayLabel("local-board")).toBe("Руководство");
    expect(formatUserDisplayLabel("local-board", new Map([["local-board", "Board"]]))).toBe("Board");
    expect(formatUserDisplayLabel("local-board", { "local-board": "You" })).toBe("You");
    expect(formatAssigneeUserDisplayLabel("user-2", "user-1", { "user-2": "Me" })).toBe("Me");
    expect(formatAssigneeUserDisplayLabel("user-abcdef", "user-1")).toBe("user-");
    expect(formatUserDisplayLabel(null)).toBeNull();
    expect(currentUserAssigneeDisplayOptions(null)).toEqual([]);
  });
});
