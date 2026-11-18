// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  readSidePanelTaskRef,
  shouldOpenTaskInSidePanel,
  withSidePanelTaskRef,
} from "./task-list-side-panel";

const plainClick = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
};

describe("shouldOpenTaskInSidePanel", () => {
  it("opens the side panel for a plain primary click", () => {
    expect(shouldOpenTaskInSidePanel(plainClick)).toBe(true);
  });

  it.each([
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["middle button", { button: 1 }],
    ["already handled", { defaultPrevented: true }],
  ])("keeps link navigation for a %s click", (_label, override) => {
    expect(shouldOpenTaskInSidePanel({ ...plainClick, ...override })).toBe(false);
  });
});

describe("side panel task param", () => {
  it("reads the open task and ignores a blank value", () => {
    expect(readSidePanelTaskRef(new URLSearchParams("task=PAP-12"))).toBe("PAP-12");
    expect(readSidePanelTaskRef(new URLSearchParams("task=%20"))).toBeNull();
    expect(readSidePanelTaskRef(new URLSearchParams("view=all"))).toBeNull();
  });

  it("sets and clears the task without touching the list params", () => {
    const list = new URLSearchParams("view=all&q=deploy&status=todo");
    const opened = withSidePanelTaskRef(list, "PAP-7");
    expect(opened.toString()).toBe("view=all&q=deploy&status=todo&task=PAP-7");
    expect(withSidePanelTaskRef(opened, null).toString()).toBe("view=all&q=deploy&status=todo");
    expect(list.toString()).toBe("view=all&q=deploy&status=todo");
  });
});
