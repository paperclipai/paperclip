// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import type { TaskChatProtocolItem, TaskChatProviderActivityItem } from "./task-chat-model";
import { TaskChatProtocolActivityRow, TaskChatProtocolActivityDetails } from "./TaskChatProtocolActivityRow";

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

  it.each(["javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd", "vbscript:unsafe"])("rejects unsafe resource URLs in rows and details: %s", (href) => {
    const item: TaskChatProtocolItem = { id: "unsafe-resource", kind: "protocol", surface: "resource", resourceKind: "document", title: "Notes", subtitle: "Document", href };
    render(item);
    expect(container.querySelector("a")).toBeNull();
    act(() => root.render(<TaskChatProtocolActivityDetails item={item} />));
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("Notes");
  });

  it.each(["https://example.com/report", "http://example.com/report", "/documents/notes", "#notes"])("allows safe resource links in details: %s", (href) => {
    act(() => root.render(<TaskChatProtocolActivityDetails item={{ id: "resource", kind: "protocol", surface: "resource", resourceKind: "document", title: "Notes", subtitle: "Document", href }} />));
    expect(container.querySelector("a")?.getAttribute("href")).toBe(href);
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

  it("keeps a notice readable and preserves metadata in a collapsed disclosure", () => {
    const summary = "Project-local configuration is disabled.\nTrust the repository to load its hooks.";
    render({
      id: "notice", kind: "protocol", surface: "provider_activity", family: "provider_notice",
      eventType: "provider.notice.recorded", status: "informational", title: "Provider notice", summary,
      details: [
        { label: "Category", value: "configWarning" },
        { label: "Recoverable", value: "Yes" },
        { label: "Provider", value: "pi" },
        { label: "Provenance", value: "provider_native" },
        { label: "Summary", value: summary },
      ], steps: [], links: [], children: [],
    });
    expect(container.textContent).toContain(`Warning${summary}`);
    expect(container.querySelector("p")?.textContent).toBe(summary);
    const disclosure = container.querySelector("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.querySelector("summary")?.textContent).toBe("Details");
    expect(Array.from(disclosure?.querySelectorAll("dt") ?? [], (term) => term.textContent)).toEqual([
      "Category", "Recoverable", "Provider", "Provenance",
    ]);
    expect(Array.from(disclosure?.querySelectorAll("dd") ?? [], (value) => value.textContent)).toEqual([
      "configWarning", "Yes", "pi", "provider_native",
    ]);
    expect(disclosure?.textContent).not.toContain(summary);
    act(() => disclosure?.querySelector("summary")?.click());
    expect(disclosure?.open).toBe(true);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-protocol-activity-icon"]')).not.toBeNull();
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
    expect(row?.querySelector("details")).toBeNull();
    expect(row?.querySelector('[aria-expanded]')).toBeNull();
  });
  it.each([
    ["info", "informational", "Provider update", "lucide-info"],
    ["warning", "informational", "Warning", "lucide-triangle-alert"],
    ["error", "failed", "Error", "lucide-triangle-alert"],
    ["error", "informational", "Error", "lucide-triangle-alert"],
    ["info", "failed", "Error", "lucide-triangle-alert"],
  ] as const)("renders %s/%s notice severity without hiding its summary", (severity, status, label, icon) => {
    const summary = "Pi estimates this turn at $0.000617. Billing cost is unverified.";
    render({
      id: "notice", kind: "protocol", surface: "provider_activity", family: "provider_notice",
      eventType: "provider.notice.recorded", status, title: "Provider notice", summary,
      details: [{ label: "Severity", value: severity }], steps: [], links: [], children: [],
    });
    expect(container.textContent).toContain(label);
    expect(container.querySelector("p")?.textContent).toBe(summary);
    expect(container.querySelector('[data-testid="task-chat-protocol-activity-icon"]')?.classList.contains(icon)).toBe(true);
  });

});
