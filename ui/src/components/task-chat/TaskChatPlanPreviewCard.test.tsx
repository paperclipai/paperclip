// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueDocument } from "@paperclipai/shared";
import { ThemeProvider } from "@/context/ThemeContext";
import {
  planPreviewContent,
  TaskChatPlanPreviewCard,
} from "./TaskChatPlanPreviewCard";
import type { TaskChatProviderActivityItem } from "./task-chat-model";
import { CoordinatorPresentation } from "@/components/coordinator/CoordinatorPresentation";

vi.mock("@/lib/router", () => ({ Link: ({ to, children, disableIssueQuicklook: _quicklook, ...props }: any) => <a href={to} {...props}>{children}</a> }));

function planDocument(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "plan-document",
    companyId: "company-1",
    issueId: "issue-1",
    key: "plan",
    title: "Plan",
    format: "markdown",
    body: "# Streaming task UX\n\n## Implementation\n- Extract the shared card.\n2. Stream provider steps.\n3. Reconcile the saved revision.\n4. Verify the mobile layout.",
    latestRevisionId: "plan-revision-4",
    latestRevisionNumber: 4,
    createdByAgentId: "agent-1",
    createdByUserId: null,
    updatedByAgentId: "agent-1",
    updatedByUserId: null,
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    createdAt: new Date("2026-08-23T10:00:00.000Z"),
    updatedAt: new Date("2026-08-23T10:01:00.000Z"),
    ...overrides,
  };
}

function livePlan(steps: TaskChatProviderActivityItem["steps"]): TaskChatProviderActivityItem {
  return {
    id: "live-plan",
    kind: "protocol",
    surface: "provider_activity",
    family: "plan",
    eventType: "plan.updated",
    status: "running",
    title: "Plan",
    summary: "Implement the streaming UX.",
    details: [{ label: "Revision", value: "5" }],
    steps,
    links: [],
    children: [],
  };
}

describe("TaskChatPlanPreviewCard", () => {
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

  it("extracts the Markdown H1 and the first three meaningful plan lines", () => {
    expect(planPreviewContent("# Ship it\n\n---\n## Build\n- **First** step\n2. Use [the docs](https://example.com)\n```\nFourth"))
      .toEqual({ title: "Ship it", preview: ["Build", "First step", "Use the docs"] });
  });

  it("renders a saved revision as a Plan-pane link", () => {
    act(() => root.render(
      <ThemeProvider>
        <TaskChatPlanPreviewCard source={{ kind: "saved", document: planDocument() }} />
      </ThemeProvider>,
    ));

    const preview = container.querySelector('[data-testid="task-chat-plan-preview"]');
    expect(preview?.getAttribute("href")).toBe("#document-plan");
    expect(preview?.getAttribute("aria-label")).toBe("Open Plan revision 4");
    expect(preview?.textContent).toContain("Plan· rev 4");
    expect(preview?.textContent).toContain("Streaming task UX");
    expect(preview?.textContent).toContain("Extract the shared card.");
    expect(preview?.textContent).not.toContain("Verify the mobile layout.");
  });

  it("replaces saved preview content when the canonical revision updates", () => {
    const render = (document: IssueDocument) => act(() => root.render(
      <ThemeProvider>
        <TaskChatPlanPreviewCard source={{ kind: "saved", document }} />
      </ThemeProvider>,
    ));
    render(planDocument());
    render(planDocument({
      body: "# Revised streaming UX\n- Preserve final-answer streaming.\n- Preserve provider redaction.",
      latestRevisionId: "plan-revision-5",
      latestRevisionNumber: 5,
    }));

    expect(container.querySelectorAll('[data-testid="task-chat-plan-preview"]')).toHaveLength(1);
    expect(container.textContent).toContain("Plan· rev 5");
    expect(container.textContent).toContain("Revised streaming UX");
    expect(container.textContent).not.toContain("Streaming task UX");
  });

  it("keeps Coordinator plans compact and links the saved revision in its owning task", () => {
    act(() => root.render(<ThemeProvider><CoordinatorPresentation.Provider value>
      <TaskChatPlanPreviewCard source={{ kind: "saved", document: planDocument() }} />
    </CoordinatorPresentation.Provider></ThemeProvider>));
    const card = container.querySelector("a")!;
    expect(card.getAttribute("href")).toBe("/issues/issue-1#document-plan&revision=plan-revision-4");
    expect(card.textContent).toContain("Open Streaming task UX");
    expect(container.querySelector("ul")).toBeNull();
    expect(container.textContent).not.toContain("Extract the shared card.");
  });

  it("does not invent a task link for an unsaved live plan", () => {
    act(() => root.render(<ThemeProvider><CoordinatorPresentation.Provider value>
      <TaskChatPlanPreviewCard source={{ kind: "live", activity: livePlan([{ id: "a", label: "Internal step", status: "in_progress" }]) }} />
    </CoordinatorPresentation.Provider></ThemeProvider>));
    expect(container.textContent).toContain("Writing Plan");
    expect(container.textContent).not.toContain("Internal step");
    expect(container.querySelector("a")).toBeNull();
  });

  it("updates a live provider preview in place as steps stream", () => {
    const render = (steps: TaskChatProviderActivityItem["steps"]) => act(() => root.render(
      <ThemeProvider>
        <TaskChatPlanPreviewCard source={{ kind: "live", activity: livePlan(steps) }} />
      </ThemeProvider>,
    ));

    render([{ id: "one", label: "Inspect the existing card", status: "in_progress" }]);
    const preview = container.querySelector('[data-testid="task-chat-plan-preview"]');
    expect(preview?.tagName).toBe("SECTION");
    expect(preview?.textContent).toContain("Writing plan· rev 5");
    expect(preview?.textContent).toContain("Inspect the existing card");

    render([
      { id: "one", label: "Inspect the existing card", status: "completed" },
      { id: "two", label: "Render streamed plan steps", status: "in_progress" },
    ]);
    expect(container.querySelectorAll('[data-testid="task-chat-plan-preview"]')).toHaveLength(1);
    expect(container.textContent).toContain("Render streamed plan steps");
  });
});
