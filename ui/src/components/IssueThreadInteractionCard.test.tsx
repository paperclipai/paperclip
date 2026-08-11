// @vitest-environment jsdom

import { act as reactAct, type ComponentProps, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueThreadInteractionCard } from "./IssueThreadInteractionCard";
import { ThemeProvider } from "../context/ThemeContext";
import { TooltipProvider } from "./ui/tooltip";
import {
  pendingAskUserQuestionsInteraction,
  pendingAskUserQuestionsWithFreeTextOption,
  commentExpiredAskUserQuestionsInteraction,
  commentExpiredRequestConfirmationInteraction,
  declinedToolActionInteraction,
  disabledDeclineReasonRequestConfirmationInteraction,
  executedToolActionInteraction,
  expiredToolActionInteraction,
  failedRequestConfirmationInteraction,
  failedToolActionInteraction,
  pendingRequestConfirmationInteraction,
  pendingToolActionDestructiveInteraction,
  pendingToolActionWriteInteraction,
  planApprovalResumeFailedRequestConfirmationInteraction,
  pendingRequestItemVerdictsInteraction,
  pendingSuggestedTasksInteraction,
  runningToolActionInteraction,
  completeRequestItemVerdictsInteraction,
  supersededRequestItemVerdictsInteraction,
  staleTargetRequestConfirmationInteraction,
  rejectedSuggestedTasksInteraction,
  agentAddressedRequestConfirmationInteraction,
  agentResolvedRequestConfirmationInteraction,
  withdrawnRequestConfirmationInteraction,
  issueClosedRequestConfirmationInteraction,
} from "../fixtures/issueThreadInteractionFixtures";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  if (typeof reactAct === "function") {
    await reactAct(callback);
    return;
  }

  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await new Promise((resolve) => setTimeout(resolve, 0));
}

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

function renderCard(
  props: Partial<ComponentProps<typeof IssueThreadInteractionCard>> = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      <TooltipProvider>
        <ThemeProvider>
          <IssueThreadInteractionCard
            interaction={pendingAskUserQuestionsInteraction}
            {...props}
          />
        </ThemeProvider>
      </TooltipProvider>,
    );
  });

  return container;
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe("IssueThreadInteractionCard", () => {
  it("exposes pending question options as selectable radio and checkbox controls", () => {
    const host = renderCard({
      interaction: pendingAskUserQuestionsInteraction,
      onSubmitInteractionAnswers: vi.fn(),
    });

    const singleGroup = host.querySelector('[role="radiogroup"]');
    expect(singleGroup?.getAttribute("aria-labelledby")).toBe(
      "interaction-questions-default-collapse-depth-prompt",
    );

    const radios = [...host.querySelectorAll('[role="radio"]')];
    expect(radios).toHaveLength(2);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("false");

    act(() => {
      (radios[0] as HTMLButtonElement).click();
    });

    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[1]?.getAttribute("aria-checked")).toBe("false");

    const multiGroup = host.querySelector('[role="group"]');
    expect(multiGroup?.getAttribute("aria-labelledby")).toBe(
      "interaction-questions-default-post-submit-summary-prompt",
    );
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(3);

    const otherLink = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent === "Other",
    );
    expect(otherLink?.getAttribute("role")).toBeNull();
    expect(otherLink?.className).toContain("underline");
  });

  it("submits written Other answers for pending questions", async () => {
    const onSubmitInteractionAnswers = vi.fn(async () => undefined);
    const host = renderCard({
      interaction: pendingAskUserQuestionsInteraction,
      onSubmitInteractionAnswers,
    });

    const otherButtons = Array.from(host.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes("Other"),
    );
    expect(otherButtons.length).toBeGreaterThan(0);

    await act(async () => {
      otherButtons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const textarea = host.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(textarea).toBeTruthy();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(textarea, "Keep only the root item open");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const summaryCheckbox = Array.from(host.querySelectorAll('[role="checkbox"]')).find((button) =>
      button.textContent?.includes("Inline answer pills"),
    );
    await act(async () => {
      summaryCheckbox?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const submitButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Send answers"),
    );
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSubmitInteractionAnswers).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ask_user_questions" }),
      [
        {
          questionId: "collapse-depth",
          optionIds: [],
          otherText: "Keep only the root item open",
        },
        {
          questionId: "post-submit-summary",
          optionIds: ["answers-inline"],
        },
      ],
    );
  });

  it("reveals an inline field when a free-text option is selected and hides the standalone Other link", async () => {
    const onSubmitInteractionAnswers = vi.fn(async () => undefined);
    const host = renderCard({
      interaction: pendingAskUserQuestionsWithFreeTextOption,
      onSubmitInteractionAnswers,
    });

    // A first-class free-text option suppresses the built-in "Other" link.
    const otherLink = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Other",
    );
    expect(otherLink).toBeUndefined();

    // No text field until the free-text option is selected.
    expect(host.querySelector("textarea")).toBeNull();

    const describeOption = Array.from(host.querySelectorAll('[role="radio"]')).find(
      (button) => button.textContent?.includes("I'll describe it"),
    ) as HTMLButtonElement | undefined;
    expect(describeOption).toBeTruthy();

    await act(async () => {
      describeOption?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(describeOption?.getAttribute("aria-checked")).toBe("true");
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(textarea).toBeTruthy();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(textarea, "Call it Threads");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const submitButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Send answers"),
    );
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSubmitInteractionAnswers).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ask_user_questions" }),
      [
        {
          questionId: "surface-name",
          optionIds: [],
          otherText: "Call it Threads",
        },
      ],
    );
  });

  it("renders nothing for a degenerate ask_user_questions card", () => {
    // A truly unanswerable question: a prompt with no options and no free-text
    // field, so there is nothing for the user to select or type. Hiding it
    // strands nothing.
    const degenerate = {
      ...pendingAskUserQuestionsInteraction,
      id: "interaction-questions-degenerate",
      payload: {
        version: 1 as const,
        title: "Placeholder",
        questions: [
          {
            id: "q1",
            prompt: "Anything?",
            selectionMode: "single" as const,
            options: [],
          },
        ],
      },
    };

    const host = renderCard({
      interaction: degenerate,
      onSubmitInteractionAnswers: vi.fn(),
    });

    // No card wrapper, no title, no controls — the component returns null.
    expect(host.childElementCount).toBe(0);
    expect(host.textContent).toBe("");
  });

  it("still renders a legitimate ask_user_questions card", () => {
    const host = renderCard({
      interaction: pendingAskUserQuestionsInteraction,
      onSubmitInteractionAnswers: vi.fn(),
    });

    expect(host.childElementCount).toBeGreaterThan(0);
    expect(host.querySelectorAll('[role="radio"]').length).toBeGreaterThan(0);
  });

  it("only shows question cancellation when a cancel handler is wired", () => {
    const withoutHandler = renderCard({
      interaction: pendingAskUserQuestionsInteraction,
      onSubmitInteractionAnswers: vi.fn(),
    });
    expect(withoutHandler.textContent).not.toContain("Cancel question");

    act(() => root?.unmount());
    withoutHandler.remove();
    root = null;

    const withHandler = renderCard({
      interaction: pendingAskUserQuestionsInteraction,
      onCancelInteraction: vi.fn(),
      onSubmitInteractionAnswers: vi.fn(),
    });
    expect(withHandler.textContent).toContain("Cancel question");
  });

  it("renders expired question interactions as resolved and non-actionable", () => {
    const host = renderCard({
      interaction: commentExpiredAskUserQuestionsInteraction,
      onSubmitInteractionAnswers: vi.fn(),
      onCancelInteraction: vi.fn(),
    });

    expect(host.textContent).toContain("Questions expired by comment");
    expect(host.textContent).toContain("A later board/user comment superseded this question request.");
    expect(host.textContent).not.toContain("Send answers");
    expect(host.textContent).not.toContain("Cancel question");

    const jumpLink = Array.from(host.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Jump to comment"),
    );
    expect(jumpLink?.getAttribute("href")).toBe(
      "#comment-22222222-2222-4222-8222-222222222222",
    );
  });

  it("uses singular copy for expired single-question interactions", () => {
    const [question] = commentExpiredAskUserQuestionsInteraction.payload.questions;
    const host = renderCard({
      interaction: {
        ...commentExpiredAskUserQuestionsInteraction,
        payload: {
          ...commentExpiredAskUserQuestionsInteraction.payload,
          questions: [question],
        },
      },
    });

    expect(host.textContent).toContain("Question expired by comment");
    expect(host.textContent).not.toContain("Questions expired by comment");
  });

  it("renders withdrawn confirmations with the withdraw reason", () => {
    const host = renderCard({
      interaction: {
        ...pendingRequestConfirmationInteraction,
        status: "cancelled",
        result: { version: 1, outcome: "withdrawn", reason: "Superseded by the hotfix plan." },
      },
      onAcceptInteraction: vi.fn(),
      onRejectInteraction: vi.fn(),
    });

    expect(host.textContent).toContain("Withdrawn");
    expect(host.textContent).toContain("Superseded by the hotfix plan.");
    expect(host.textContent).not.toContain("Decline");
  });

  it("renders confirmations expired by issue closure with dedicated copy", () => {
    const host = renderCard({
      interaction: {
        ...pendingRequestConfirmationInteraction,
        status: "expired",
        result: { version: 1, outcome: "issue_closed", reason: null },
      },
    });

    expect(host.textContent).toContain("Expired · issue closed");
    expect(host.textContent).toContain("This confirmation expired automatically when the issue reached a terminal state.");
    expect(host.textContent).not.toContain("Expired by target change");
  });

  it("renders withdrawn question interactions with the withdraw reason", () => {
    const host = renderCard({
      interaction: {
        ...pendingAskUserQuestionsInteraction,
        status: "cancelled",
        result: {
          version: 1,
          outcome: "withdrawn",
          reason: "Scope was decided on the parent issue.",
          answers: [],
          summaryMarkdown: null,
        },
      },
    });

    expect(host.textContent).toContain("Questions withdrawn");
    expect(host.textContent).toContain("Scope was decided on the parent issue.");
    expect(host.textContent).not.toContain("Question cancelled");
  });

  it("renders question interactions expired by issue closure with dedicated copy", () => {
    const host = renderCard({
      interaction: {
        ...pendingAskUserQuestionsInteraction,
        status: "expired",
        result: {
          version: 1,
          outcome: "issue_closed",
          reason: null,
          answers: [],
          summaryMarkdown: null,
        },
      },
    });

    expect(host.textContent).toContain("Questions expired when the issue closed");
    expect(host.textContent).toContain("This question request expired automatically when the issue reached a terminal state.");
    expect(host.textContent).not.toContain("expired by comment");
  });

  it("makes child tasks explicit in suggested task trees", () => {
    const host = renderCard({
      interaction: pendingSuggestedTasksInteraction,
    });

    expect(host.textContent).toContain("Child task");
  });

  it("shows an explicit placeholder when a rejected interaction has no reason", () => {
    const host = renderCard({
      interaction: {
        ...rejectedSuggestedTasksInteraction,
        result: { version: 1 },
      },
    });

    expect(host.textContent).toContain("No reason provided.");
  });

  it("requires a revision note when the request confirmation payload asks for one", async () => {
    const onRejectInteraction = vi.fn(async () => undefined);
    const host = renderCard({
      interaction: pendingRequestConfirmationInteraction,
      onRejectInteraction,
    });

    // rejectRequiresReason drops the bare Reject: the only send-back path is Revise…
    expect(Array.from(host.querySelectorAll("button")).some((button) =>
      button.textContent?.trim() === "Reject",
    )).toBe(false);
    const reviseButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Revise"),
    );
    expect(reviseButton).toBeTruthy();

    await act(async () => {
      reviseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const sendButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Send revision"),
    );
    expect(sendButton?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      sendButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(host.textContent).toContain("Add a note describing the changes you want.");
    expect(onRejectInteraction).not.toHaveBeenCalled();

    const textarea = host.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(textarea).toBeTruthy();
    expect(textarea?.getAttribute("aria-invalid")).toBe("true");

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(textarea, "Needs a smaller phase split");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const enabledSendButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Send revision"),
    );
    expect(enabledSendButton?.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      enabledSendButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRejectInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "request_confirmation" }),
      "Needs a smaller phase split",
    );
  });

  it("invokes the confirm callback with pending request confirmations", async () => {
    const onAcceptInteraction = vi.fn(async () => undefined);
    const host = renderCard({
      interaction: pendingRequestConfirmationInteraction,
      onAcceptInteraction,
    });

    const confirmButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Approve plan"),
    );
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAcceptInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "request_confirmation" }),
    );
  });

  it("standardizes the bare-reject button to Reject even when the payload carries a legacy rejectLabel", () => {
    const host = renderCard({
      interaction: {
        ...pendingRequestConfirmationInteraction,
        payload: {
          ...pendingRequestConfirmationInteraction.payload,
          // Onboarding/plan-approval interactions are still seeded with the
          // legacy "Request changes" reject label; it must not leak into the CTA.
          rejectLabel: "Request changes",
          rejectRequiresReason: false,
        },
      },
      onAcceptInteraction: vi.fn(async () => undefined),
      onRejectInteraction: vi.fn(async () => undefined),
    });

    const labels = Array.from(host.querySelectorAll("button")).map((button) =>
      button.textContent?.trim(),
    );

    // Canonical plan-approval grammar, right→left: Approve · Revise… · Reject.
    // "Revise…" already carries the send-back-with-notes path, so a distinct
    // "Request changes" word is redundant and must not render.
    expect(labels).toContain("Reject");
    expect(labels).toContain("Revise…");
    expect(labels.some((label) => label?.includes("Approve"))).toBe(true);
    expect(host.textContent).not.toContain("Request changes");
  });

  it("does not expose continuation wake policy labels in the card header", () => {
    const host = renderCard({
      interaction: {
        ...pendingRequestConfirmationInteraction,
        continuationPolicy: "wake_assignee_on_accept",
      },
    });

    expect(host.textContent).not.toContain("Wakes on confirm");
    expect(host.textContent).not.toContain("Wakes assignee");
  });

  it("renders request confirmation target links and stale-target expiry", () => {
    const host = renderCard({
      interaction: staleTargetRequestConfirmationInteraction,
    });

    const targetLinks = host.querySelectorAll("a");
    expect(host.textContent).toContain("Expired by target change");
    expect(host.textContent).toContain("Plan v3");
    expect(host.textContent).toContain("Plan v4");
    expect(targetLinks[0]?.getAttribute("href")).toContain("#document-plan");
    expect(targetLinks[1]?.getAttribute("href")).toContain("#document-plan");
    expect(host.textContent).not.toContain("Approve plan");
  });

  it("renders a jump link for confirmations expired by comment", () => {
    const host = renderCard({
      interaction: commentExpiredRequestConfirmationInteraction,
    });

    const jumpLink = Array.from(host.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Jump to comment"),
    );

    expect(jumpLink?.getAttribute("href")).toBe(
      "#comment-22222222-2222-4222-8222-222222222222",
    );
  });

  it("declines immediately when decline reasons are disabled", async () => {
    const onRejectInteraction = vi.fn(async () => undefined);
    const host = renderCard({
      interaction: disabledDeclineReasonRequestConfirmationInteraction,
      onRejectInteraction,
    });

    // The bare-reject button always renders the canonical "Reject", not the
    // payload's "Keep it" — ConfirmationActionRow no longer honors the override.
    const declineButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.trim() === "Reject",
    );
    expect(declineButton).toBeTruthy();

    await act(async () => {
      declineButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(host.querySelector("textarea")).toBeNull();
    expect(onRejectInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "request_confirmation" }),
      undefined,
    );
  });

  it("renders explicit copy for failed request confirmations", () => {
    const host = renderCard({
      interaction: failedRequestConfirmationInteraction,
    });

    expect(host.textContent).toContain(
      "This request could not be resolved. Try again or create a new request.",
    );
  });

  it("renders a plan confirmation as a distinct state-coloured plan card", () => {
    const pending = renderCard({ interaction: pendingRequestConfirmationInteraction });
    const pendingShell = pending.firstElementChild as HTMLElement;
    expect(pendingShell.className).toContain("border-violet-500/80");
    expect(pendingShell.className).not.toContain("border-l-");
    expect(pending.textContent).toContain("Plan");
    expect(pending.textContent).toContain("In review");
    // Approve is a neutral CTA (foreground/background), not the blue primary.
    const approve = Array.from(pending.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Approve plan"),
    );
    expect(approve?.className).toContain("bg-foreground");
    expect(approve?.className).not.toContain("bg-primary");

    act(() => root?.unmount());
    pending.remove();
    root = null;

    const accepted = renderCard({
      interaction: { ...pendingRequestConfirmationInteraction, status: "accepted" },
    });
    expect((accepted.firstElementChild as HTMLElement).className).toContain("border-green-500/80");
    expect(accepted.textContent).toContain("Approved");

    act(() => root?.unmount());
    accepted.remove();
    root = null;

    const resumeFailed = renderCard({
      interaction: planApprovalResumeFailedRequestConfirmationInteraction,
    });
    expect((resumeFailed.firstElementChild as HTMLElement).className).toContain("border-amber-500/70");
    expect(resumeFailed.textContent).toContain("Approved — agent resume failed");
    expect(resumeFailed.textContent).toContain("Agent resume failed");
    expect(resumeFailed.textContent).toContain("Paperclip needs attention before the agent can resume this approved work.");
    expect(resumeFailed.textContent).toContain("adapter_failed");

    act(() => root?.unmount());
    resumeFailed.remove();
    root = null;

    const rejected = renderCard({
      interaction: {
        ...pendingRequestConfirmationInteraction,
        status: "rejected",
        result: { version: 1, outcome: "rejected", reason: "Tighten the spacing" },
      },
    });
    expect((rejected.firstElementChild as HTMLElement).className).toContain("border-red-500/80");
    expect(rejected.textContent).toContain("Changes requested");
  });

  it("attaches screenshots to a plan request-changes reason as markdown images", async () => {
    const onRejectInteraction = vi.fn(async () => undefined);
    const onUploadImage = vi.fn(async () => "https://cdn.example/shot.png");
    const host = renderCard({
      interaction: {
        ...pendingRequestConfirmationInteraction,
        payload: {
          ...pendingRequestConfirmationInteraction.payload,
          rejectRequiresReason: false,
        },
      },
      onRejectInteraction,
      onUploadImage,
    });

    const reviseButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Revise"),
    );
    await act(async () => {
      reviseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const attachButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Attach screenshots"),
    );
    expect(attachButton).toBeTruthy();

    const fileInput = host.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).toBeTruthy();
    const file = new File(["x"], "bug.png", { type: "image/png" });
    Object.defineProperty(fileInput!, "files", { value: [file], configurable: true });
    Object.defineProperty(fileInput!, "value", {
      value: "C:/fake/bug.png",
      writable: true,
      configurable: true,
    });

    await act(async () => {
      fileInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onUploadImage).toHaveBeenCalledTimes(1);

    const sendButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Send revision"),
    );
    await act(async () => {
      sendButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRejectInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "request_confirmation" }),
      "![bug.png](https://cdn.example/shot.png)",
    );
  });

  it("submits an approve verdict once a draft is marked and applied", async () => {
    const onSubmitInteractionVerdicts = vi.fn(async () => undefined);
    const host = renderCard({
      interaction: pendingRequestItemVerdictsInteraction,
      onSubmitInteractionVerdicts,
    });

    const firstItemId = pendingRequestItemVerdictsInteraction.payload.items[0]!.id;
    const approveButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>(`[data-item-id="${firstItemId}"] button[data-verdict="approve"]`),
    )[0];
    expect(approveButton).toBeTruthy();
    // 44px minimum target (a11y).
    expect(approveButton?.className).toContain("min-h-11");

    await act(async () => {
      approveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const applyButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Apply 1 decision"),
    );
    expect(applyButton).toBeTruthy();

    await act(async () => {
      applyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSubmitInteractionVerdicts).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "request_item_verdicts" }),
      [{ id: firstItemId, verdict: "approve", reason: undefined }],
    );
  });

  it("blocks apply for a rejected item until a reason is entered", async () => {
    const onSubmitInteractionVerdicts = vi.fn(async () => undefined);
    const host = renderCard({
      interaction: pendingRequestItemVerdictsInteraction,
      onSubmitInteractionVerdicts,
    });

    const firstItemId = pendingRequestItemVerdictsInteraction.payload.items[0]!.id;
    const rejectButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>(`[data-item-id="${firstItemId}"] button[data-verdict="reject"]`),
    )[0];
    await act(async () => {
      rejectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Reject reveals a required reason field.
    const reasonField = host.querySelector<HTMLTextAreaElement>(
      `textarea[id="${pendingRequestItemVerdictsInteraction.id}-${firstItemId}-reason"]`,
    );
    expect(reasonField).toBeTruthy();

    const applyButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Apply 1 decision"),
    );
    // Attempting to apply without a reason does not submit.
    await act(async () => {
      applyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSubmitInteractionVerdicts).not.toHaveBeenCalled();
    expect(host.textContent).toContain("A reason is required to reject this item.");
  });

  it("renders resolved verdicts as terminal chips with reason echo", () => {
    const host = renderCard({ interaction: completeRequestItemVerdictsInteraction });
    expect(host.textContent).toContain("Approved");
    expect(host.textContent).toContain("Rejected");
    expect(host.textContent).toContain("Tone is off-brand");
    // S5 summary chip.
    expect(host.textContent).toContain("3 approved");
    // No actionable verdict buttons once terminal.
    expect(host.querySelector("button[data-verdict]")).toBeNull();
  });

  it("shows an already-applied, cannot-revert notice when superseded", () => {
    const host = renderCard({ interaction: supersededRequestItemVerdictsInteraction });
    expect(host.textContent).toContain("expired after a later comment");
    expect(host.textContent).toContain("cannot be");
    expect(host.textContent?.toLowerCase()).toContain("revert");
  });
});

describe("IssueThreadInteractionCard tool-action card", () => {
  it("selects the pending state with the Approve & run affordance and identity header", () => {
    const host = renderCard({
      interaction: pendingToolActionWriteInteraction,
      onAcceptInteraction: vi.fn(),
      onRejectInteraction: vi.fn(),
    });

    // Pending eyebrow, never a bare "Accepted".
    expect(host.textContent).toContain("Awaiting approval");
    // Identity header: tool display name + WRITE risk badge + app/tool sub-line.
    expect(host.textContent).toContain("Append row to spreadsheet");
    expect(host.textContent).toContain("WRITE");
    expect(host.textContent).toContain("Google Sheets");
    // Primary CTA is "Approve & run" (approve = run), plus the hint + countdown.
    const approve = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Approve & run"),
    );
    expect(approve).toBeTruthy();
    expect(host.textContent).toContain("Approving runs this action now.");
    expect(host.textContent).toContain("Approval expires in");
    // Technical details drawer is present but collapsed by default (hash hidden).
    expect(host.textContent).toContain("Technical details");
    expect(host.textContent).not.toContain("args hash");
  });

  it("uses the destructive risk badge and a destructive primary button", () => {
    const host = renderCard({
      interaction: pendingToolActionDestructiveInteraction,
      onAcceptInteraction: vi.fn(),
      onRejectInteraction: vi.fn(),
    });

    expect(host.textContent).toContain("DESTRUCTIVE");
    const approve = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Approve & run"),
    );
    expect(approve?.getAttribute("data-variant")).toBe("destructive");
  });

  it("reveals redacted args and the hash when the technical drawer is opened", () => {
    const host = renderCard({
      interaction: pendingToolActionWriteInteraction,
      onAcceptInteraction: vi.fn(),
      onRejectInteraction: vi.fn(),
    });

    const trigger = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Technical details"),
    );
    act(() => {
      (trigger as HTMLButtonElement).click();
    });

    expect(host.textContent).toContain("args hash");
    expect(host.textContent).toContain("sha256:9f2c1a7be4d0c8a3");
    // Redacted arguments render verbatim, never raw secrets.
    expect(host.textContent).toContain("[redacted]");
  });

  it("renders the approved-running state with a spinner and no action buttons", () => {
    const host = renderCard({ interaction: runningToolActionInteraction });

    expect(host.textContent).toContain("Running…");
    expect(host.textContent).toContain("running the action now");
    expect(host.textContent).not.toContain("Approve & run");
    expect(host.querySelector(".animate-spin")).toBeTruthy();
  });

  it("renders the executed state with a result summary and never reads Accepted", () => {
    const host = renderCard({ interaction: executedToolActionInteraction });

    expect(host.textContent).toContain("Executed");
    expect(host.textContent).toContain("Row 42 added");
    expect(host.textContent).not.toContain("Accepted");
    const link = Array.from(host.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("View result"),
    );
    expect(link?.getAttribute("href")).toContain("docs.google.com");
  });

  it("distinguishes failed (ran + connector error) from declined (did not run)", () => {
    const failed = renderCard({ interaction: failedToolActionInteraction });
    expect(failed.textContent).toContain("Failed");
    expect(failed.textContent).toContain("insufficient_permission");
    expect(failed.textContent).toContain("but the connector returned an error");

    act(() => root?.unmount());
    failed.remove();
    root = null;

    const declined = renderCard({ interaction: declinedToolActionInteraction });
    expect(declined.textContent).toContain("Declined");
    expect(declined.textContent).toContain("did");
    expect(declined.textContent).toContain("not");
    expect(declined.textContent).toContain("run");
    expect(declined.textContent).toContain("use the CRM sync instead");
    expect(declined.textContent).not.toContain("Approve & run");
  });

  it("renders the expired state with the 60-minute rule and a recovery path", () => {
    const host = renderCard({ interaction: expiredToolActionInteraction });

    expect(host.textContent).toContain("Expired");
    expect(host.textContent).toContain("no one responded within 60 minutes");
    expect(host.textContent).toContain("the agent can request approval again");
    expect(host.textContent).not.toContain("Approve & run");
  });

  it("keeps the generic confirmation rendering for cards without a toolAction", () => {
    const host = renderCard({
      interaction: pendingRequestConfirmationInteraction,
      onAcceptInteraction: vi.fn(),
      onRejectInteraction: vi.fn(),
    });

    // Legacy confirmation keeps its own prompt + labels, no tool-action surface.
    expect(host.textContent).toContain("Approve the plan and let the responsible start implementation?");
    expect(host.textContent).not.toContain("Approve & run");
    expect(host.textContent).not.toContain("Technical details");
  });

  it("renders the addressee chip without the removed policy badge", () => {
    const host = renderCard({
      interaction: agentAddressedRequestConfirmationInteraction,
    });

    // PAP-440: the "Agents may resolve" policy badge was pure noise — never rendered.
    expect(host.querySelector('[data-testid="interaction-policy-badge"]')).toBeNull();

    const addresseeBadge = host.querySelector('[data-testid="interaction-addressee-badge"]');
    expect(addresseeBadge?.textContent).toContain("For ");
  });

  it("omits the addressee badge for a board-only interaction", () => {
    const host = renderCard({
      interaction: pendingRequestConfirmationInteraction,
    });

    expect(host.querySelector('[data-testid="interaction-policy-badge"]')).toBeNull();
    expect(host.querySelector('[data-testid="interaction-addressee-badge"]')).toBeNull();
  });

  it("marks agent resolution with an audit chip in the resolved footer", () => {
    const host = renderCard({
      interaction: agentResolvedRequestConfirmationInteraction,
    });

    const footer = host.querySelector('[data-testid="interaction-resolved-footer"]');
    expect(footer?.textContent).toContain("Resolved by");
    expect(
      host.querySelector('[data-testid="interaction-resolved-by-agent-chip"]'),
    ).not.toBeNull();
  });

  it("renders a withdrawn footer with the withdrawer, reason, and agent chip", () => {
    const host = renderCard({
      interaction: withdrawnRequestConfirmationInteraction,
    });

    // Header status reads "Withdrawn", not the raw "Cancelled" status.
    expect(host.textContent).toContain("Withdrawn");
    // Withdrawn is a neutral administrative retraction — it must NOT wear the
    // cancelled/rejected costume (rose/red border + XCircle). The shell is muted
    // (border-border), never a rose/red alarm colour (design review R2).
    const cardRoot = host.querySelector("div.rounded-lg.p-5.shadow-none");
    expect(cardRoot?.className).toContain("border-border");
    expect(cardRoot?.className).not.toMatch(/border-(rose|red)/);
    // The header status icon is MinusCircle ("retracted"), never XCircle ("denied").
    const statusIcon = cardRoot?.querySelector("svg");
    expect(statusIcon?.getAttribute("class")).toContain("lucide-circle-minus");
    expect(statusIcon?.getAttribute("class")).not.toContain("lucide-circle-x");
    const footer = host.querySelector('[data-testid="interaction-withdrawn-footer"]');
    expect(footer?.textContent).toContain("Withdrawn by");
    expect(footer?.textContent).toContain("Plan superseded by a newer revision");
    expect(
      footer?.querySelector('[data-testid="interaction-resolved-by-agent-chip"]'),
    ).not.toBeNull();
    // The generic "Resolved by" footer must not double-render.
    expect(host.querySelector('[data-testid="interaction-resolved-footer"]')).toBeNull();
  });

  it("renders an issue-closed expiry footer for terminal auto-expiry", () => {
    const host = renderCard({
      interaction: issueClosedRequestConfirmationInteraction,
    });

    // Footer is trimmed to just the audit timestamp — the header status badge
    // already carries the "Expired · issue closed" label, so the footer must
    // not restate it.
    const footer = host.querySelector('[data-testid="interaction-issue-closed-footer"]');
    expect(footer?.textContent).toContain("Apr 20");
    expect(footer?.textContent).not.toContain("Expired when the issue closed");
    // The "Expired · issue closed" label survives exactly once (the header
    // status badge); the duplicate body eyebrow was dropped.
    const label = "Expired · issue closed";
    const occurrences = (host.textContent ?? "").split(label).length - 1;
    expect(occurrences).toBe(1);
  });
});
