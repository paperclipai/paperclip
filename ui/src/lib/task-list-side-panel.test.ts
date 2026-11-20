// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import {
  findIssueByRef,
  readSidePanelTaskRef,
  resolveTaskListSidePanelPresentation,
  shouldOpenTaskInSidePanel,
  taskChatShellLayoutClass,
  withSidePanelTaskRef,
} from "./task-list-side-panel";

describe("resolveTaskListSidePanelPresentation", () => {
  it.each([
    [375, "full-page"],
    [414, "full-page"],
    [767, "full-page"],
  ])("keeps the full task page on a %ipx phone", (width, expected) => {
    expect(resolveTaskListSidePanelPresentation(width)).toBe(expected);
  });

  it.each([
    [768, "overlay"],
    [1023, "overlay"],
  ])("covers the list with an overlay on a %ipx tablet", (width, expected) => {
    expect(resolveTaskListSidePanelPresentation(width)).toBe(expected);
  });

  it.each([
    [1024, "docked"],
    [1440, "docked"],
  ])("docks the panel beside the list at %ipx", (width, expected) => {
    expect(resolveTaskListSidePanelPresentation(width)).toBe(expected);
  });
});

describe("findIssueByRef", () => {
  const issues = [{ id: "id-1", identifier: "PAP-1" }, { id: "id-2", identifier: "PAP-2" }] as Issue[];

  it("matches the open task by identifier or by id", () => {
    expect(findIssueByRef(issues, "PAP-2")?.id).toBe("id-2");
    expect(findIssueByRef(issues, "id-1")?.identifier).toBe("PAP-1");
  });

  it("returns nothing for a closed panel or an unknown task", () => {
    expect(findIssueByRef(issues, null)).toBeUndefined();
    expect(findIssueByRef(issues, "PAP-9")).toBeUndefined();
  });

  it("reads each task at most once in a large list", () => {
    const size = 5_000;
    let reads = 0;
    const countRead = (value: string) => {
      if (++reads > size) throw new Error(`findIssueByRef read ${reads} tasks for a list of ${size}`);
      return value;
    };
    const large = Array.from({ length: size }, (_, i) => ({
      get id() { return countRead(`id-${i}`); },
      identifier: `PAP-${i}`,
    })) as Issue[];
    expect(findIssueByRef(large, "PAP-missing")).toBeUndefined();
    expect(reads).toBe(size);
  });
});

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

describe("taskChatShellLayoutClass", () => {
  it("pulls the page chat out to the gutters", () => {
    expect(taskChatShellLayoutClass({ isMobile: false, streamlined: false, embedded: false })).toContain("md:-mx-6");
  });

  it("keeps the streamlined page chat free of offsets", () => {
    expect(taskChatShellLayoutClass({ isMobile: false, streamlined: true, embedded: false })).not.toContain("-mx");
  });

  it("adds no negative offsets inside the embedded side panel", () => {
    expect(taskChatShellLayoutClass({ isMobile: false, streamlined: false, embedded: true })).not.toContain("-m");
  });
});
