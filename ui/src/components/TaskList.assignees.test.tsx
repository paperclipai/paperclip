// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appearanceForPalette } from "@paperclipai/shared";
import { createIssue } from "../../storybook/fixtures/paperclipData";
import { TaskList, type TaskListItem } from "./TaskList";
import { TooltipProvider } from "./ui/tooltip";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, state: _state, disableIssueQuicklook: _quicklook, issuePrefetch: _prefetch, ...props }:
    ComponentProps<"a"> & { to?: string; state?: unknown; disableIssueQuicklook?: boolean; issuePrefetch?: unknown }) =>
    <a href={to} {...props}>{children}</a>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const agentItem: TaskListItem = {
  issue: createIssue({ id: "agent-task", title: "Agent task", assigneeAgentId: "agent-1", assigneeUserId: null }),
  assignee: "Research Agent",
  assigneeAgent: {
    id: "agent-1",
    name: "Research Agent",
    appearance: { ...appearanceForPalette("deep-tide"), customAvatarAssetId: "22222222-2222-4222-8222-222222222222" },
  },
};
const humanItem: TaskListItem = {
  issue: createIssue({ id: "human-task", title: "Human task", assigneeAgentId: null, assigneeUserId: "user-1" }),
  assignee: "Alex Smith",
  assigneeUserAvatarUrl: "/api/assets/33333333-3333-4333-8333-333333333333/content",
};
const brokenHumanAvatar = "/api/assets/44444444-4444-4444-8444-444444444444/content";
const imageRequests = vi.fn<(src: string) => void>();

describe("TaskList assignee identities", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    imageRequests.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    // Radix preloads profile pictures through Image. jsdom does not load them.
    vi.stubGlobal("Image", class extends EventTarget {
      complete = false;
      naturalWidth = 0;
      set src(value: string) {
        imageRequests(value);
        queueMicrotask(() => {
          this.complete = true;
          this.naturalWidth = value === brokenHumanAvatar ? 0 : 100;
          this.dispatchEvent(new Event(this.naturalWidth ? "load" : "error"));
        });
      }
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(items: TaskListItem[]) {
    await act(async () => root.render(
      <TooltipProvider><TaskList items={items} initialColumns={["task", "assignee"]} /></TooltipProvider>,
    ));
  }

  const cell = (title: string) => host.querySelector(`[role="rowgroup"][aria-label="${title} task group"] [role="cell"][data-column="assignee"]`)!;

  it("shows agent appearance and human profile pictures beside their names", async () => {
    await render([agentItem, humanItem]);
    expect(cell("Agent task").textContent).toBe("Research Agent");
    expect(cell("Agent task").querySelector("img")?.getAttribute("src")).toBe("/api/assets/22222222-2222-4222-8222-222222222222/content");
    expect(cell("Human task").textContent).toBe("Alex Smith");
    expect(cell("Human task").querySelector("img")?.getAttribute("src")).toBe(humanItem.assigneeUserAvatarUrl);
  });

  it.each([
    "https://example.com/track.png",
    "http://example.com/track.png",
    "//example.com/track.png",
    "/profile/alex.png",
  ])("uses initials without loading an untrusted human avatar: %s", async (source) => {
    await render([{ ...humanItem, assigneeUserAvatarUrl: source }]);
    expect(cell("Human task").querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe("AS");
    expect(cell("Human task").querySelector("img")).toBeNull();
    expect(imageRequests).not.toHaveBeenCalled();
  });

  it("uses initials for missing or failed pictures and leaves unassigned rows without an avatar", async () => {
    const unassigned: TaskListItem = {
      issue: createIssue({ id: "unassigned-task", title: "Unassigned task", assigneeAgentId: null, assigneeUserId: null }),
    };
    await render([agentItem, { ...humanItem, assigneeUserAvatarUrl: null }, unassigned]);
    expect(cell("Human task").querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe("AS");
    expect(cell("Unassigned task").textContent).toBe("Unassigned");
    expect(cell("Unassigned task").querySelector("img, [data-slot=avatar], [data-slot=agent-avatar]")).toBeNull();

    await act(async () => cell("Agent task").querySelector("img")!.dispatchEvent(new Event("error")));
    expect(cell("Agent task").querySelector('[data-slot="agent-avatar"]')?.textContent).toBe("RA");
    await render([{ ...humanItem, assigneeUserAvatarUrl: brokenHumanAvatar }]);
    expect(cell("Human task").querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe("AS");
    expect(cell("Human task").querySelector("img")).toBeNull();
  });

  it("removes and restores assignee avatars through the Columns control", async () => {
    await render([agentItem, humanItem]);
    const columns = host.querySelector<HTMLButtonElement>('button[aria-label="Columns"]')!;
    await act(async () => columns.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const assignee = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(item => item.textContent === "Assignee")!;
    expect(assignee).toBeDefined();
    await act(async () => assignee.click());
    expect(host.querySelector('[role="cell"][data-column="assignee"]')).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    await act(async () => assignee.click());
    expect(cell("Agent task").querySelector("img")?.getAttribute("src")).toBe("/api/assets/22222222-2222-4222-8222-222222222222/content");
    expect(cell("Human task").querySelector("img")?.getAttribute("src")).toBe(humanItem.assigneeUserAvatarUrl);
  });
});
