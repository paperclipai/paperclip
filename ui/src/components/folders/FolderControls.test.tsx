// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderListResult } from "@paperclipai/shared";
import {
  AllUnfiledBanner,
  BulkBar,
  DeleteFolderDialog,
  FolderFormDialog,
  FolderRail,
  MobileFolderSheet,
  MoveToMenu,
  folderSearchValue,
  normalizeFolderSelection,
} from "./FolderControls";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined;
}

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
      parentId: null,
      name: "Reporting",
      slug: "reporting",
      systemKey: null,
      path: "reporting",
      depth: 1,
      color: "indigo",
      position: 0,
      itemCount: 3,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
  ],
};

const skillFolderResult: FolderListResult = {
  kind: "skill",
  allCount: 8,
  unfiledCount: 1,
  folders: [
    {
      ...folderResult.folders[0]!,
      id: "my",
      kind: "skill",
      name: "my",
      slug: "my",
      systemKey: "my",
      path: "my",
      itemCount: 1,
    },
    {
      ...folderResult.folders[0]!,
      id: "engineering",
      kind: "skill",
      name: "Engineering",
      slug: "engineering",
      path: "engineering",
      itemCount: 3,
    },
    {
      ...folderResult.folders[0]!,
      id: "code-review",
      kind: "skill",
      parentId: "engineering",
      name: "Code Review",
      slug: "code-review",
      path: "engineering/code-review",
      depth: 2,
      itemCount: 2,
    },
    {
      ...folderResult.folders[0]!,
      id: "projects",
      kind: "skill",
      name: "projects",
      slug: "projects",
      systemKey: "projects",
      path: "projects",
      itemCount: 2,
    },
    {
      ...folderResult.folders[0]!,
      id: "bundled",
      kind: "skill",
      name: "bundled",
      slug: "bundled",
      systemKey: "bundled",
      path: "bundled",
      itemCount: 1,
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

  it("marks the active row with aria-current, including virtual Unfiled", () => {
    root = createRoot(container);
    act(() => {
      root?.render(
        <FolderRail
          result={folderResult}
          selection="unfiled"
          itemLabelPlural="routines"
          allLabel="All routines"
          onSelect={vi.fn()}
          onCreate={vi.fn()}
          onRename={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
    });

    const current = container.querySelector('[aria-current="page"]');
    expect(current?.textContent).toContain("Unfiled");
  });

  it("renames a folder inline via double-click and Enter", () => {
    const onRename = vi.fn();
    root = createRoot(container);
    act(() => {
      root?.render(
        <FolderRail
          result={folderResult}
          selection="all"
          itemLabelPlural="routines"
          allLabel="All routines"
          onSelect={vi.fn()}
          onCreate={vi.fn()}
          onRename={onRename}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
    });

    const nameButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Reporting"),
    );
    act(() => {
      nameButton?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });

    const input = container.querySelector<HTMLInputElement>("input");
    expect(input).toBeTruthy();
    expect(input?.value).toBe("Reporting");

    act(() => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Monthly reports");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onRename).toHaveBeenCalledWith(folderResult.folders[0], "Monthly reports");
  });

  it("moves via MoveToMenu: Unfiled, a folder, and new-folder chaining", () => {
    const onMove = vi.fn();
    const onCreateAndMove = vi.fn();
    root = createRoot(container);
    act(() => {
      root?.render(
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger asChild>
            <button type="button">Row actions</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <MoveToMenu
              folders={folderResult.folders}
              currentFolderId={null}
              onMove={onMove}
              onCreateAndMove={onCreateAndMove}
            />
          </DropdownMenuContent>
        </DropdownMenu>,
      );
    });

    const subTrigger = Array.from(document.querySelectorAll("[data-radix-collection-item]")).find(
      (element) => element.textContent?.includes("Move to"),
    );
    expect(subTrigger).toBeTruthy();
    act(() => {
      subTrigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
    const unfiledItem = menuItems.find((element) => element.textContent?.includes("Unfiled"));
    const folderItem = menuItems.find((element) => element.textContent?.includes("Reporting"));
    const newFolderItem = menuItems.find((element) => element.textContent?.includes("New folder"));
    expect(unfiledItem).toBeTruthy();
    expect(folderItem).toBeTruthy();
    expect(newFolderItem).toBeTruthy();

    act(() => {
      unfiledItem?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onMove).toHaveBeenCalledWith(null);

    act(() => {
      folderItem?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onMove).toHaveBeenCalledWith("folder-reporting");

    act(() => {
      newFolderItem?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onCreateAndMove).toHaveBeenCalled();
  });

  it("creates a folder through FolderFormDialog and disables submit on empty name", () => {
    const onSubmit = vi.fn();
    root = createRoot(container);
    act(() => {
      root?.render(
        <FolderFormDialog
          open
          kind="routine"
          folder={null}
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
        />,
      );
    });

    const submit = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Create folder",
    ) as HTMLButtonElement | undefined;
    expect(submit).toBeTruthy();
    expect(submit?.disabled).toBe(true);

    const nameInput = document.querySelector<HTMLInputElement>("#folder-name");
    act(() => {
      if (!nameInput) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(nameInput, "Reporting");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(submit?.disabled).toBe(false);
    act(() => {
      submit?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith({ name: "Reporting", color: expect.any(String) });
  });

  it("states the forgiving delete behavior and confirms", () => {
    const onConfirm = vi.fn();
    root = createRoot(container);
    act(() => {
      root?.render(
        <DeleteFolderDialog
          open
          folder={folderResult.folders[0]!}
          itemLabelPlural="routines"
          onOpenChange={vi.fn()}
          onConfirm={onConfirm}
        />,
      );
    });

    expect(document.body.textContent).toContain("3 routines in this folder won't be deleted");
    expect(document.body.textContent).toContain("They'll move to Unfiled");

    const confirmButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete folder",
    );
    act(() => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onConfirm).toHaveBeenCalled();
  });

  it("selects a folder from the mobile sheet and dismisses", () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    root = createRoot(container);
    act(() => {
      root?.render(
        <MobileFolderSheet
          open
          onOpenChange={onOpenChange}
          result={folderResult}
          selection="all"
          allLabel="All routines"
          itemLabelPlural="Routines"
          onSelect={onSelect}
          onCreate={vi.fn()}
        />,
      );
    });

    expect(document.body.textContent).toContain("All routines");
    expect(document.body.textContent).toContain("Unfiled");

    const reportingRow = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Reporting"),
    );
    act(() => {
      reportingRow?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onSelect).toHaveBeenCalledWith("folder-reporting");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("preserves skill root grouping and child hierarchy in the mobile sheet", () => {
    root = createRoot(container);
    act(() => {
      root?.render(
        <MobileFolderSheet
          open
          onOpenChange={vi.fn()}
          result={skillFolderResult}
          selection="all"
          allLabel="All skills"
          itemLabelPlural="Skills"
          onSelect={vi.fn()}
          onCreate={vi.fn()}
        />,
      );
    });

    const body = document.body.textContent ?? "";
    expect(body.indexOf("My Skills")).toBeLessThan(body.indexOf("Company"));
    expect(body.indexOf("Company")).toBeLessThan(body.indexOf("Engineering"));
    expect(body.indexOf("Engineering")).toBeLessThan(body.indexOf("Code Review"));
    expect(body.indexOf("Code Review")).toBeLessThan(body.indexOf("Projects"));
    expect(body.indexOf("Projects")).toBeLessThan(body.indexOf("Bundled"));
    expect(document.querySelector('[data-folder-id="engineering"] > .pl-3 [data-folder-id="code-review"]')).not.toBeNull();
  });

  it("persists AllUnfiledBanner dismissal across mounts", () => {
    const storageKey = "paperclip:test-folder-nudge";
    window.localStorage.removeItem(storageKey);
    const onCreateFolder = vi.fn();
    root = createRoot(container);
    act(() => {
      root?.render(
        <AllUnfiledBanner
          storageKey={storageKey}
          itemLabelPlural="routines"
          onCreateFolder={onCreateFolder}
        />,
      );
    });

    expect(container.textContent).toContain("Create your first folder");

    const dismissButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss folder suggestion"]',
    );
    act(() => {
      dismissButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).not.toContain("Create your first folder");
    expect(window.localStorage.getItem(storageKey)).toBe("1");

    act(() => {
      root?.unmount();
    });
    root = createRoot(container);
    act(() => {
      root?.render(
        <AllUnfiledBanner
          storageKey={storageKey}
          itemLabelPlural="routines"
          onCreateFolder={onCreateFolder}
        />,
      );
    });
    expect(container.textContent).not.toContain("Create your first folder");
    window.localStorage.removeItem(storageKey);
  });
});
