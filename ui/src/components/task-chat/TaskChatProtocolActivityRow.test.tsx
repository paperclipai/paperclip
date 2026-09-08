// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import type { TaskChatProtocolItem, TaskChatProviderActivityItem } from "./task-chat-model";
import { TaskChatProtocolActivityRow } from "./TaskChatProtocolActivityRow";

describe("TaskChatProtocolActivityRow", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(item: TaskChatProtocolItem) {
    act(() => root.render(
      <MemoryRouter>
        <ThemeProvider>
          <TaskChatProtocolActivityRow item={item} />
        </ThemeProvider>
      </MemoryRouter>,
    ));
  }

  it("renders long research results as a bounded readable list", () => {
    const item: TaskChatProviderActivityItem = {
      id: "research",
      kind: "protocol",
      surface: "provider_activity",
      family: "research",
      eventType: "research.completed",
      status: "completed",
      title: "Research",
      summary: "smoked pork shoulder",
      details: [
        { label: "Action", value: "search" },
        { label: "Status", value: "completed" },
        { label: "Query", value: "site:nextjs.org/docs/app/api-reference/config/eslint Next.js 16 eslint.config.mjs core-web-vitals typescript", mono: true },
      ],
      steps: [],
      links: Array.from({ length: 6 }, (_, index) => ({
        label: `Next.js configuration result ${index + 1}`,
        href: `https://nextjs.org/docs/result-${index + 1}`,
        description: "A long provider-authored snippet that stays on one compact line in the activity feed.",
      })),
      children: [],
    };
    render(item);

    const row = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-protocol-activity-row"] button');
    expect(container.querySelector("article")).toBeNull();
    expect(row?.textContent).toContain("Searched the web");
    expect(row?.textContent).toContain("smoked pork shoulder");
    expect(
      row
        ?.querySelector('[data-testid="task-chat-protocol-activity-icon"]')
        ?.parentElement?.classList.contains("justify-center"),
    ).toBe(true);
    expect(
      row?.querySelector(".task-chat-collapsed-line-fade")?.textContent,
    ).toContain("smoked pork shoulder");
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    expect(row?.getAttribute("aria-controls")).toMatch(/^task-chat-protocol-activity-/);

    act(() => row?.click());

    expect(row?.getAttribute("aria-expanded")).toBe("true");
    const detail = container.querySelector('[data-testid="task-chat-protocol-activity-detail"]');
    expect(detail?.id).toBe(row?.getAttribute("aria-controls"));
    expect(detail?.querySelector('[data-testid="task-chat-research-query"]')?.textContent).toContain("eslint.config.mjs");
    expect(detail?.querySelectorAll('ol[aria-label="Research sources"] li')).toHaveLength(5);
    expect(detail?.textContent).toContain("Show 1 more result");
    expect(detail?.textContent).not.toContain("Actionsearch");

    const showMore = Array.from(detail?.querySelectorAll("button") ?? []).find((button) => button.textContent?.includes("Show 1 more result"));
    act(() => showMore?.click());
    expect(detail?.querySelectorAll('ol[aria-label="Research sources"] li')).toHaveLength(6);
  });

  it("summarizes workspace files without rendering inline diff bodies", () => {
    render({
      id: "workspace",
      kind: "protocol",
      surface: "workspace_change",
      changeSetId: "change-1",
      revision: 1,
      source: "runner_verified",
      complete: true,
      files: Array.from({ length: 10 }, (_, index) => ({
        path: `ui/src/file-${index + 1}.tsx`,
        operation: "modify" as const,
        previousPath: null,
        additions: 1,
        deletions: 1,
        binary: false,
        diff: `-old-${index + 1}\n+new-${index + 1}`,
      })),
      totals: { files: 10, additions: 10, deletions: 10 },
      patchArtifactRef: null,
    });

    const row = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-protocol-activity-row"] button');
    expect(row?.textContent).toContain("Edited files");
    act(() => row?.click());
    expect(container.textContent).toContain("ui/src/file-1.tsx");
    expect(container.textContent).toContain("2 more files not shown");
    expect(container.textContent).not.toContain("new-1");
    expect(container.querySelector('[data-testid="task-chat-workspace-change-details"] pre')).toBeNull();
  });

  it("renders durable resources as direct compact links", () => {
    render({
      id: "resource",
      kind: "protocol",
      surface: "resource",
      resourceKind: "document",
      title: "Implementation notes",
      subtitle: "markdown · ready",
      href: "/documents/notes",
    });

    const link = container.querySelector<HTMLAnchorElement>('[data-testid="task-chat-protocol-activity-row"]');
    expect(link?.getAttribute("href")).toBe("/documents/notes");
    expect(link?.textContent).toContain("Added a document");
    expect(link?.textContent).toContain("Implementation notes");
  });

  it("renders MCP executions with semantic copy, source metadata, and the MCP icon", () => {
    render({
      id: "tool",
      kind: "protocol",
      surface: "provider_activity",
      family: "tool_execution",
      eventType: "tool.execution.completed",
      status: "completed",
      title: "Tool execution",
      summary: "Searching the task index",
      details: [
        { label: "Transport", value: "mcp" },
        { label: "Namespace", value: "paperclip", mono: true },
        { label: "Operation", value: "search" },
        { label: "Name", value: "search_tasks", mono: true },
      ],
      steps: [],
      links: [],
      children: [],
    });

    const row = container.querySelector('[data-testid="task-chat-protocol-activity-row"]');
    expect(row?.textContent).toContain("Searched tasks");
    expect(row?.textContent).toContain("Searching the task index · Paperclip · search_tasks");
    expect(row?.textContent).not.toMatch(/Ran a tool|Tool execution|tool call/i);
    expect(row?.querySelector('[data-testid="task-chat-protocol-activity-icon"]')?.querySelectorAll("path")).toHaveLength(3);
  });

  it("does not make an informational row focusable when it has no details", () => {
    render({
      id: "notice",
      kind: "protocol",
      surface: "provider_activity",
      family: "provider_notice",
      eventType: "provider.notice.recorded",
      status: "informational",
      title: "Provider notice",
      summary: "Retrying automatically",
      details: [],
      steps: [],
      links: [],
      children: [],
    });

    const row = container.querySelector('[data-testid="task-chat-protocol-activity-row"]');
    expect(row?.querySelector("button")).toBeNull();
    expect(row?.querySelector('[aria-expanded]')).toBeNull();
  });
});
