// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderListResult } from "@paperclipai/shared";
import { SkillFolderRail } from "./SkillFolderTree";

function pointerEvent(type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

const result: FolderListResult = {
  kind: "skill",
  allCount: 12,
  unfiledCount: 2,
  folders: [
    {
      id: "my-root",
      companyId: "company-1",
      kind: "skill",
      parentId: null,
      name: "My Skills",
      slug: "my",
      systemKey: "my",
      path: "my",
      depth: 1,
      color: null,
      position: 0,
      itemCount: 4,
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
      updatedAt: new Date("2026-07-16T00:00:00.000Z"),
    },
    {
      id: "personal-root",
      companyId: "company-1",
      kind: "skill",
      parentId: "my-root",
      name: "Ada",
      slug: "ada",
      systemKey: "my:user-1",
      path: "my/ada",
      depth: 2,
      color: null,
      position: 0,
      itemCount: 4,
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
      updatedAt: new Date("2026-07-16T00:00:00.000Z"),
    },
  ],
};

describe("SkillFolderRail", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSelect = vi.fn<(selection: string) => void>();

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onSelect.mockClear();
    flushSync(() => {
      root.render(
        <SkillFolderRail
          result={result}
          selection="all"
          tags={[]}
          activeTag={null}
          onSelect={onSelect}
          onSelectTag={vi.fn()}
          onCreateFolder={vi.fn()}
          onRenameFolder={vi.fn()}
          onEditFolder={vi.fn()}
          onMoveFolder={vi.fn()}
          onDeleteFolder={vi.fn()}
        />,
      );
    });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    window.localStorage.clear();
  });

  it("uses the wider default and persists drag resizing", () => {
    const rail = container.firstElementChild as HTMLDivElement;
    const separator = container.querySelector('[role="separator"]') as HTMLDivElement;
    expect(rail.style.width).toBe("288px");
    separator.setPointerCapture = vi.fn();

    flushSync(() => {
      separator.dispatchEvent(pointerEvent("pointerdown", 288));
      separator.dispatchEvent(pointerEvent("pointermove", 320));
      separator.dispatchEvent(pointerEvent("pointerup", 320));
    });

    expect(rail.style.width).toBe("320px");
    expect(window.localStorage.getItem("paperclip.skills.folderRail.width")).toBe("320");
  });

  it("keeps virtual and folder counts on the same grid column", () => {
    const allRow = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("All skills"));
    const myLabel = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("My Skills"));
    const myRow = myLabel?.parentElement;

    expect(allRow?.className).toContain("grid-cols-(--gtc-folder-row-actions)");
    expect(myRow?.className).toContain("grid-cols-(--gtc-folder-row-actions)");
    expect(allRow?.querySelector(".tabular-nums")?.textContent).toBe("12");
    expect(myRow?.querySelector(".tabular-nums")?.textContent).toBe("4");
  });

  it("selects and toggles a folder when its row label is clicked", () => {
    const myLabel = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("My Skills"));

    expect(container.textContent).not.toContain("Ada");
    flushSync(() => myLabel?.click());

    expect(onSelect).toHaveBeenCalledWith("my-root");
    expect(container.textContent).toContain("Ada");
    expect(container.querySelector('[aria-label="Collapse folder"]')).not.toBeNull();
  });
});
