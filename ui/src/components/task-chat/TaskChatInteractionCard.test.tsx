// @vitest-environment jsdom

import { act, forwardRef, useImperativeHandle, type ForwardedRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueDocument } from "@paperclipai/shared";
import type {
  IssueThreadInteraction,
  RequestConfirmationInteraction,
} from "@/lib/issue-thread-interactions";
import { ThemeProvider } from "@/context/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  expiredSecretProposalInteraction,
  pendingAskUserQuestionsInteraction,
  pendingRequestCheckboxConfirmationInteraction,
  pendingRequestItemVerdictsInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import { TaskChatInteractionCard } from "./TaskChatInteractionCard";
import { TaskChatThreadView } from "./TaskChatThreadView";
import type { TaskChatInteractionItem } from "./task-chat-model";

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(function MockMarkdownEditor(
    {
      value,
      onChange,
      placeholder,
      imageUploadHandler,
    }: {
      value: string;
      onChange: (value: string) => void;
      placeholder?: string;
      imageUploadHandler?: (file: File) => Promise<string>;
    },
    ref: ForwardedRef<unknown>,
  ) {
    useImperativeHandle(ref, () => ({
      insertMarkdown: (markdown: string) => onChange(`${value}${markdown}`),
      focus: () => {},
    }));
    return (
      <textarea
        data-testid="mock-markdown-editor"
        data-image-upload={imageUploadHandler ? "true" : "false"}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }),
}));

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
    resolverPolicy: "anyone",
    requestedResolverPolicy: "anyone",
    effectiveResolverPolicy: "anyone",
    resolverPolicyProvenance: "inherited",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: {
      requested: "board_or_agents",
      effective: "board_or_agents",
    },
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
  interaction: IssueThreadInteraction,
): TaskChatInteractionItem {
  return {
    id: `interaction:${interaction.id}`,
    kind: "interaction",
    interaction,
  };
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

  it("does not render a pending confirmation in the timeline", () => {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard
              item={interactionItem(createRequestConfirmation())}
            />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });
    const card = container.querySelector(
      '[data-testid="task-chat-interaction"]',
    );
    expect(card).toBeNull();
    expect(container.textContent).not.toContain("Requested confirmation");
    expect(container.textContent).not.toContain("waiting for response");
    expect(container.textContent).not.toContain("Approve the plan?");
  });

  it("renders a plan confirmation as a linked document preview", () => {
    const interaction = createRequestConfirmation({
      sourceRunId: "run-plan",
      title: "Review plan revision 3",
      payload: {
        version: 1,
        prompt: "Approve plan revision 3?",
        acceptLabel: "Approve plan",
        target: {
          type: "issue_document",
          issueId: "issue-1",
          documentId: "document-plan",
          key: "plan",
          revisionId: "revision-3",
          revisionNumber: 3,
          label: "Plan v3",
        },
      },
    });
    const planDocument = {
      id: "document-plan",
      issueId: "issue-1",
      key: "plan",
      title: "Plan",
      body: "# Health-check endpoint\n1. Define the health response contract.\n2. Test readiness before and after startup.\n3. Document the verification request.",
      latestRevisionId: "revision-3",
      latestRevisionNumber: 3,
    } as IssueDocument;

    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard
              item={interactionItem(interaction)}
              planDocument={planDocument}
            />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    const preview = container.querySelector(
      '[data-testid="plan-review-preview"]',
    );
    expect(preview?.getAttribute("href")).toBe("#document-plan");
    expect(preview?.getAttribute("aria-label")).toBe("Open Plan revision 3");
    expect(container.textContent).toContain("Health-check endpoint");
    expect(container.textContent).toContain(
      "Test readiness before and after startup.",
    );
    expect(container.textContent).not.toContain("Approve plan revision 3?");
    expect(container.textContent).not.toContain("Approve plan");
    expect(container.textContent).not.toContain("Requested plan review");
  });

  it("renders a runner-owned expired plan review as a receipt without a second preview", () => {
    const interaction = createRequestConfirmation({
      sourceRunId: "run-plan",
      status: "expired",
      title: "Review plan revision 3",
      payload: {
        version: 1,
        prompt: "Approve plan revision 3?",
        target: {
          type: "issue_document",
          issueId: "issue-1",
          documentId: "document-plan",
          key: "plan",
          revisionId: "revision-3",
          label: "Plan v3",
        },
      },
      result: {
        version: 1,
        outcome: "superseded_by_comment",
        commentId: "comment-1",
      },
    });
    const planDocument = {
      id: "document-plan",
      issueId: "issue-1",
      key: "plan",
      title: "Plan",
      body: "# Health-check endpoint",
      latestRevisionId: "revision-3",
      latestRevisionNumber: 3,
    } as IssueDocument;

    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard
              item={interactionItem(interaction)}
              planDocument={planDocument}
              showPlanPreview={false}
            />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    expect(
      container.querySelector('[data-testid="plan-review-preview"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-interaction-receipt"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain(
      "Confirmation expired after comment",
    );
  });

  it("does not put the latest plan body into an older revision receipt", () => {
    const interaction = createRequestConfirmation({
      status: "expired",
      payload: {
        version: 1,
        prompt: "Approve plan revision 2?",
        target: {
          type: "issue_document",
          issueId: "issue-1",
          documentId: "document-plan",
          key: "plan",
          revisionId: "revision-2",
          label: "Plan revision 2",
        },
      },
      result: {
        version: 1,
        outcome: "superseded_by_comment",
        commentId: "comment-1",
      },
    });
    const currentPlan = {
      id: "document-plan",
      issueId: "issue-1",
      key: "plan",
      title: "Plan",
      body: "# Revision 3 only\nThis must not appear in the revision 2 receipt.",
      latestRevisionId: "revision-3",
      latestRevisionNumber: 3,
    } as IssueDocument;

    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard
              item={interactionItem(interaction)}
              planDocument={currentPlan}
            />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    expect(
      container.querySelector('[data-testid="plan-review-preview"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Revision 3 only");
    expect(container.textContent).toContain(
      "Confirmation expired after comment",
    );
  });

  it("puts the primary CTA at the right edge of the compact action row", () => {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard
              item={interactionItem(createRequestConfirmation())}
              presentation="takeover"
            />
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
    expect(Array.from(row?.querySelectorAll("button") ?? []).at(-1)).toBe(
      approve,
    );
    expect(container.textContent).not.toContain("proposed by");
    expect(container.textContent).not.toContain(
      "Review and approve the latest plan.",
    );
    expect(container.textContent).not.toContain("Needs response");
    expect(container.textContent).not.toContain("Anyone can respond");
    expect(
      container.querySelector('[data-testid="interaction-status-badge"]'),
    ).toBeNull();
  });

  it("keeps the plan revision in the header and hides the prompt while requesting changes", async () => {
    const interaction = createRequestConfirmation({
      sourceRunId: "run-plan",
      title: "Review the proposed plan",
      payload: {
        version: 1,
        prompt: "Do you accept this plan?",
        acceptLabel: "Approve plan",
        rejectLabel: "Request changes",
        rejectRequiresReason: true,
        rejectReasonLabel: "What should change?",
        target: {
          type: "issue_document",
          issueId: "issue-1",
          documentId: "document-plan",
          key: "plan",
          revisionId: "revision-4",
          revisionNumber: 4,
        },
      },
    });

    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard
              item={interactionItem(interaction)}
              presentation="takeover"
              onAcceptInteraction={vi.fn()}
              onRejectInteraction={vi.fn()}
              onUploadImage={vi.fn().mockResolvedValue("/uploads/boat.png")}
            />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    const title = Array.from(container.querySelectorAll("strong")).find(
      (candidate) => candidate.textContent === "Review the proposed plan",
    );
    const revision = Array.from(container.querySelectorAll("span")).find(
      (candidate) => candidate.textContent === "plan · v4",
    );
    expect(title?.parentElement).toBe(revision?.parentElement);
    expect(container.textContent).toContain("Do you accept this plan?");
    expect(container.querySelectorAll(".border-t")).toHaveLength(0);

    const requestChanges = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Request changes");
    flushSync(() => requestChanges?.click());

    expect(container.textContent).not.toContain("Do you accept this plan?");
    expect(container.textContent).toContain("What should change?");
    expect(container.textContent).toContain("plan · v4");
    expect(
      container.querySelector('[data-testid="plan-revision-composer"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="mock-markdown-editor"]')
        ?.getAttribute("data-image-upload"),
    ).toBe("true");
    expect(container.textContent).not.toContain("Attach image");
    expect(container.textContent).not.toContain("drop/paste an image");
    const reasonGroup = container.querySelector(
      '[data-testid="plan-revision-composer"]',
    )?.parentElement;
    expect(reasonGroup?.className).toContain("space-y-2");
    expect(reasonGroup?.className).not.toContain("mt-3");
  });

  it("shows one question at a time and preserves answers across pages", async () => {
    const submit = vi.fn();
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard
              item={interactionItem(pendingAskUserQuestionsInteraction)}
              presentation="takeover"
              onSubmitInteractionAnswers={submit}
            />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    expect(container.textContent).toContain("1 of 2");
    expect(container.textContent).not.toContain("Choose one");
    expect(container.textContent).toContain("How aggressive should");
    expect(container.textContent).not.toContain(
      "What should the answered-state card emphasize",
    );

    const firstAnswer = Array.from(container.querySelectorAll("button")).find(
      (button) =>
        button.textContent?.includes("Only collapse hidden descendants"),
    );
    await act(async () => firstAnswer?.click());

    expect(container.textContent).toContain("2 of 2");
    expect(container.textContent).toContain(
      "What should the answered-state card emphasize",
    );
    expect(container.textContent).not.toContain("How aggressive should");

    const secondAnswer = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Inline answer pills"),
    );
    await act(async () => secondAnswer?.click());
    const send = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Send answers",
    );
    await act(async () => send?.click());

    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]?.[1]).toEqual([
      { questionId: "collapse-depth", optionIds: ["visible-root"] },
      { questionId: "post-submit-summary", optionIds: ["answers-inline"] },
    ]);
  });

  it("collapses answered questions to one expandable timeline row", () => {
    const answered = structuredClone(pendingAskUserQuestionsInteraction);
    answered.status = "answered";
    answered.resolvedAt = new Date("2026-08-24T13:30:00.000Z");
    answered.result = {
      version: 1,
      answers: [{ questionId: "collapse-depth", optionIds: ["visible-root"] }],
    };
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard item={interactionItem(answered)} />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    const receipt = container.querySelector<HTMLDetailsElement>(
      '[data-testid="task-chat-answered-questions-receipt"]',
    );
    expect(receipt?.open).toBe(false);
    expect(receipt?.querySelector("summary")?.textContent).toBe(
      "Questions answered",
    );
    expect(receipt?.querySelectorAll("summary svg")).toHaveLength(2);
    expect(receipt?.className).not.toContain("border");
    expect(receipt?.className).not.toContain("bg-card");
    expect(receipt?.querySelector("summary")?.className).toContain("px-1");
    expect(receipt?.querySelector("summary")?.className).toContain(
      "text-muted-foreground",
    );
    expect(receipt?.querySelector("summary")?.className).toContain("leading-5");
    expect(receipt?.querySelector("summary span")?.className).not.toContain(
      "font-medium",
    );
    expect(
      receipt
        ?.querySelector('[data-testid="task-chat-interaction-receipt-icon"]')
        ?.classList.contains("h-3.5"),
    ).toBe(true);
    const iconSlot = receipt?.querySelector(
      '[data-testid="task-chat-interaction-receipt-icon-slot"]',
    );
    expect(iconSlot?.classList.contains("w-6")).toBe(true);
    expect(iconSlot?.classList.contains("items-center")).toBe(true);
    expect(iconSlot?.classList.contains("justify-center")).toBe(true);
    const caret = receipt?.querySelector(
      '[data-testid="task-chat-interaction-receipt-caret"]',
    );
    expect(caret?.classList.contains("h-3")).toBe(true);
    expect(caret?.classList.contains("opacity-0")).toBe(true);
    expect(caret?.getAttribute("class")).toContain("group-hover:opacity-70");
    expect(container.textContent).not.toContain("Answered 2 questions");
    expect(container.textContent).not.toContain(
      "View original request and resolution",
    );
    expect(container.textContent).not.toContain("Options:");
    expect(container.textContent).not.toContain("Asked by:");
    expect(container.textContent).not.toContain("Resolved by:");
  });

  it("collapses accepted confirmations and selections to one borderless row", () => {
    const acceptedConfirmation = createRequestConfirmation({
      status: "accepted",
      resolvedAt: new Date("2026-08-24T13:30:00.000Z"),
      result: { version: 1, outcome: "accepted" },
    });
    const acceptedSelection = structuredClone(
      pendingRequestCheckboxConfirmationInteraction,
    );
    acceptedSelection.status = "accepted";
    acceptedSelection.resolvedAt = new Date("2026-08-24T13:31:00.000Z");
    acceptedSelection.result = {
      version: 1,
      outcome: "accepted",
      selectedOptionIds: [],
    };

    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <>
              <TaskChatInteractionCard
                item={interactionItem(acceptedConfirmation)}
              />
              <TaskChatInteractionCard
                item={interactionItem(acceptedSelection)}
              />
            </>
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    const receipts = container.querySelectorAll<HTMLDetailsElement>(
      '[data-testid="task-chat-interaction-receipt"]',
    );
    expect(receipts).toHaveLength(2);
    expect(receipts[0]?.querySelector("summary")?.textContent).toBe(
      "Confirmed request",
    );
    expect(receipts[1]?.querySelector("summary")?.textContent).toBe(
      "Confirmed with no options selected",
    );
    for (const receipt of receipts) {
      expect(receipt.open).toBe(false);
      expect(receipt.className).not.toContain("border");
      expect(receipt.className).not.toContain("bg-card");
    }
    expect(container.textContent).not.toContain("Asked by:");
    expect(container.textContent).not.toContain("Outcome:");
  });

  it("reuses the question form for a recovered harness text request", async () => {
    const submit = vi.fn();
    const recovered = structuredClone(pendingAskUserQuestionsInteraction);
    recovered.id = "recovered-runtime-question";
    recovered.title = "Configure deployment";
    recovered.payload = {
      version: 1,
      supersedeOnUserComment: false,
      submitLabel: "Continue",
      questions: [
        {
          id: "replicas",
          prompt: "How many replicas?",
          selectionMode: "single",
          required: true,
          options: [
            {
              id: "__paperclip_text__",
              label: "Enter an integer",
              freeText: true,
            },
          ],
        },
      ],
      questionSet: {
        schema: "paperclip.question_set.v1",
        title: "Configure deployment",
        description: "The provider disconnected while waiting for this answer.",
        submitLabel: "Continue",
        questions: [
          {
            id: "replicas",
            header: "Replicas",
            prompt: "How many replicas?",
            required: true,
            answerMode: "text",
            textValidation: { inputType: "integer", minimum: 1, maximum: 10 },
          },
        ],
      },
    };
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard
              item={interactionItem(recovered)}
              presentation="takeover"
              onSubmitInteractionAnswers={submit}
            />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    expect(container.textContent).toContain(
      "The provider disconnected while waiting for this answer.",
    );
    expect(container.textContent).toContain("Write an answer");
    expect(container.textContent).not.toContain("Required");
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "3");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Continue",
    );
    await act(async () => send?.click());

    expect(submit).toHaveBeenCalledWith(recovered, [
      {
        questionId: "replicas",
        optionIds: [],
        otherText: "3",
      },
    ]);
  });

  it("paginates item verdicts instead of expanding the whole review set", async () => {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard
              item={interactionItem(pendingRequestItemVerdictsInteraction)}
              presentation="takeover"
              onSubmitInteractionVerdicts={() => undefined}
            />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    expect(container.textContent).toContain("1 of 5");
    expect(container.textContent).toContain("Spring launch recap");
    expect(container.textContent).not.toContain("Monthly changelog digest");
    expect(
      container.querySelector('[aria-label="Item pagination"]'),
    ).not.toBeNull();

    const approve = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "approve",
    );
    const rejectOnFirstItem = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "reject");
    expect(approve?.className).toContain("text-emerald-700");
    expect(rejectOnFirstItem?.className).toContain("text-destructive");
    expect(approve?.querySelector("svg")).not.toBeNull();
    expect(rejectOnFirstItem?.querySelector("svg")).not.toBeNull();
    await act(async () => approve?.click());

    expect(container.textContent).toContain("2 of 5");
    expect(container.textContent).toContain("Monthly changelog digest");
    expect(container.textContent).not.toContain("Spring launch recap");

    const reject = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "reject",
    );
    await act(async () => reject?.click());
    expect(container.textContent).toContain("Why reject?");
    expect(container.textContent).toContain("Submit rejection reason");
    expect(container.textContent).toContain("2 of 5");
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Next item"]')
        ?.disabled,
    ).toBe(true);

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "Needs a warmer introduction.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Next item"]')
        ?.disabled,
    ).toBe(true);
    const submitReason = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Submit rejection reason",
    );
    await act(async () => submitReason?.click());
    expect(container.textContent).toContain("3 of 5");
    expect(container.textContent).toContain("Founder's note on reliability");
  });

  it("collapses an expired confirmation receipt at the request position", () => {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard
              item={interactionItem(
                createRequestConfirmation({ status: "expired" }),
              )}
            />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });
    const receipt = container.querySelector<HTMLDetailsElement>(
      '[data-testid="task-chat-interaction-receipt"]',
    );
    expect(receipt).not.toBeNull();
    expect(receipt?.open).toBe(false);
    expect(container.textContent).toContain("Approve the plan");
    expect(container.textContent).toContain("expired");
    expect(container.textContent).toContain("Approve the plan?");
    expect(receipt?.querySelector("summary")?.textContent).toBe(
      "Confirmation expired",
    );
    expect(container.textContent).not.toContain(
      "View original request and resolution",
    );
  });

  it("keeps security details inside an expandable expired receipt", () => {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard
              item={interactionItem(expiredSecretProposalInteraction)}
            />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    expect(
      container.querySelector('[data-testid="task-chat-interaction-receipt"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Confirmation expired");
    expect(container.textContent).toContain("OpenAI API key");
    expect(container.textContent).toContain("access.evals_openai_api_key");
    expect(container.textContent).toContain("EvalsEngineer");
    expect(container.textContent).not.toContain("Asked by:");
    expect(container.textContent).not.toContain("Resolved:");
    expect(container.textContent).not.toContain("Outcome:");
  });

  it("keeps skipped confirmation context, actor metadata, and terminal reason expandable", () => {
    const skipped = createRequestConfirmation({
      status: "cancelled",
      resolvedByUserId: "user-1",
      resolvedAt: new Date("2026-04-06T12:05:00.000Z"),
      result: {
        version: 1,
        outcome: "skipped",
        reason: "I want to write a normal message.",
      },
    });
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard
              item={interactionItem(skipped)}
              agentMap={
                new Map([
                  ["agent-1", { id: "agent-1", name: "Planner" }],
                ]) as never
              }
              userLabelMap={new Map([["user-1", "Riley"]])}
            />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    const receipt = container.querySelector<HTMLDetailsElement>(
      '[data-testid="task-chat-interaction-receipt"]',
    );
    expect(receipt?.open).toBe(false);
    expect(receipt?.querySelector("summary")?.textContent).toBe(
      "Skipped interaction",
    );
    expect(container.textContent).toContain("Approve the plan?");
    expect(container.textContent).not.toContain("Asked by:");
    expect(container.textContent).not.toContain("Resolved by:");
    expect(container.textContent).not.toContain("Outcome:");
    expect(container.textContent).toContain(
      "I want to write a normal message.",
    );
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
    const item = interactionItem(
      createRequestConfirmation({
        status: "accepted",
        result: { version: 1, outcome: "accepted" },
      }),
    );
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatThreadView
              items={[
                {
                  id: "turn-boundary",
                  kind: "marker",
                  variant: "turn_boundary",
                  label: "Earlier activity",
                },
                item,
              ]}
              scroll={false}
              renderInteraction={(it) => <TaskChatInteractionCard item={it} />}
            />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });
    expect(
      container.querySelector('[data-testid="task-chat-interaction"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="task-chat-interaction"]')
        ?.parentElement?.classList.contains("-mt-3"),
    ).toBe(true);
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
    expect(
      container.querySelector('[data-testid="task-chat-interaction"]'),
    ).toBeNull();
  });
});
