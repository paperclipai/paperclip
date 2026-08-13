// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestConfirmationInteraction } from "@/lib/issue-thread-interactions";
import { ThemeProvider } from "@/context/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TaskChatInteractionCard } from "./TaskChatInteractionCard";
import { TaskChatThreadView } from "./TaskChatThreadView";
import type { TaskChatInteractionItem } from "./task-chat-model";

function createRequestConfirmation(
  overrides: Partial<RequestConfirmationInteraction> = {},
): RequestConfirmationInteraction {
  return {
    id: "confirmation-1",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "request_confirmation",
    title: "Approve the plan",
    summary: "Review and approve the latest plan.",
    status: "pending",
    continuationPolicy: "wake_assignee",
    resolverPolicy: "board_only",
    requestedResolverPolicy: "board_only",
    effectiveResolverPolicy: "board_only",
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-04-06T12:01:00.000Z"),
    updatedAt: new Date("2026-04-06T12:01:00.000Z"),
    resolvedAt: null,
    payload: {
      version: 1,
      prompt: "Approve the plan?",
    },
    result: null,
    ...overrides,
  };
}

function interactionItem(
  interaction: RequestConfirmationInteraction,
): TaskChatInteractionItem {
  return { id: `interaction:${interaction.id}`, kind: "interaction", interaction };
}

describe("TaskChatInteractionCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("renders a pending confirmation as a full interaction card", () => {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
          <TaskChatInteractionCard item={interactionItem(createRequestConfirmation())} />
        </ThemeProvider>
        </TooltipProvider>,
      );
    });
    const card = container.querySelector('[data-testid="task-chat-interaction"]');
    expect(card).not.toBeNull();
    expect(card?.id).toBe("interaction-confirmation-1");
    expect(container.textContent).toContain("Approve the plan");
  });

  it("puts the primary CTA on the right via a reversed action row", () => {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
          <TaskChatInteractionCard item={interactionItem(createRequestConfirmation())} />
        </ThemeProvider>
        </TooltipProvider>,
      );
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const approve = buttons.find((button) => button.textContent === "Approve");
    const reject = buttons.find((button) => button.textContent === "Reject");
    expect(approve).not.toBeUndefined();
    expect(reject).not.toBeUndefined();
    const row = approve?.parentElement;
    expect(row).toBe(reject?.parentElement);
    expect(row?.className).toContain("flex-row-reverse");
  });

  it("demotes an expired confirmation to a marker row", () => {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
          <TaskChatInteractionCard
            item={interactionItem(createRequestConfirmation({ status: "expired" }))}
          />
        </ThemeProvider>
        </TooltipProvider>,
      );
    });
    expect(container.querySelector('[data-testid="task-chat-interaction"]')).toBeNull();
    expect(container.textContent).toContain("Approve the plan");
    expect(container.textContent).toContain("expired");
  });
});

describe("TaskChatThreadView interaction items", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("renders interaction items through renderInteraction", () => {
    const item = interactionItem(createRequestConfirmation());
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
          <TaskChatThreadView
            items={[item]}
            scroll={false}
            renderInteraction={(it) => <TaskChatInteractionCard item={it} />}
          />
        </ThemeProvider>
        </TooltipProvider>,
      );
    });
    expect(container.querySelector('[data-testid="task-chat-interaction"]')).not.toBeNull();
  });

  it("renders nothing for interaction items without renderInteraction", () => {
    const item = interactionItem(createRequestConfirmation());
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
          <TaskChatThreadView items={[item]} scroll={false} />
        </ThemeProvider>
        </TooltipProvider>,
      );
    });
    expect(container.querySelector('[data-testid="task-chat-interaction"]')).toBeNull();
  });
});
