// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderListResult } from "@paperclipai/shared";
import {
  FolderRail,
  folderSearchValue,
  normalizeFolderSelection,
} from "./FolderControls";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

const folderResult: FolderListResult = {
  kind: "routine",
  allCount: 4,
  unfiledCount: 1,
  folders: [
    {
      id: "folder-reporting",
      companyId: "company-1",
      kind: "routine",
      name: "Reporting",
      color: "#6366f1",
      position: 0,
      itemCount: 3,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
  ],
};

describe("FolderControls", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
  });

  it("normalizes URL selection values for folder persistence", () => {
    expect(normalizeFolderSelection(null)).toBe("all");
    expect(normalizeFolderSelection("unfiled")).toBe("unfiled");
    expect(normalizeFolderSelection("folder-reporting")).toBe("folder-reporting");
    expect(folderSearchValue("all")).toBe("");
    expect(folderSearchValue("unfiled")).toBe("unfiled");
    expect(folderSearchValue("folder-reporting")).toBe("folder-reporting");
  });

  it("renders All, user folders, and Unfiled with counts and selection callbacks", () => {
    const onSelect = vi.fn();
    root = createRoot(container);

    act(() => {
      root?.render(
        <FolderRail
          result={folderResult}
          selection="all"
          itemLabelPlural="routines"
          allLabel="All routines"
          onSelect={onSelect}
          onCreate={vi.fn()}
          onRename={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("All routines");
    expect(container.textContent).toContain("Reporting");
    expect(container.textContent).toContain("Unfiled");
    expect(container.textContent).toContain("4");
    expect(container.textContent).toContain("3");
    expect(container.textContent).toContain("1");

    const reportingButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Reporting"),
    );
    expect(reportingButton).toBeTruthy();

    act(() => {
      reportingButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onSelect).toHaveBeenCalledWith("folder-reporting");
  });
});
