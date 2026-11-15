// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { taskCreatedItems } from "./task-created-items";
import { TaskChatTaskCreatedCard } from "./TaskChatTaskCreatedCard";

vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a> }));

const created = (overrides: Partial<Issue>): Issue => ({
  id: "child", companyId: "company", identifier: "ONB-1", title: "Paperclip onboarding", parentId: "parent",
  createdByAgentId: "agent", createdAt: new Date("2026-11-05T12:00:00Z"), status: "todo", ...overrides,
}) as Issue;

describe("task created chat card (BUG-07)", () => {
  it("keeps the presentation fields so the chip matches the task pane", () => {
    const [item] = taskCreatedItems([created({
      status: "blocked",
      blockerAttention: { state: "covered", reason: "active_child", unresolvedBlockerCount: 1, coveredBlockerCount: 1,
        attentionBlockerCount: 0, stalledBlockerCount: 0, sampleBlockerIdentifier: "ONB-3", sampleStalledBlockerIdentifier: null },
    })], "parent", "company", new Set());
    const html = renderToStaticMarkup(<TaskChatTaskCreatedCard item={item!} />);
    expect(html).toContain("var(--status-task-icon-in_queue)");
    expect(html).toContain("Blocked · waiting on active sub-task ONB-3");
  });

  it("shows a waiting review as Idle, like the task pane", () => {
    const [item] = taskCreatedItems([created({ status: "in_review", externalConversationState: "waiting" })], "parent", "company", new Set());
    expect(renderToStaticMarkup(<TaskChatTaskCreatedCard item={item!} />)).toContain(">Idle<");
  });
});
