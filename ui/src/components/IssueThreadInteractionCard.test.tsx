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
  commentExpiredAskUserQuestionsInteraction,
  commentExpiredRequestConfirmationInteraction,
  disabledDeclineReasonRequestConfirmationInteraction,
  failedRequestConfirmationInteraction,
  pendingRequestConfirmationInteraction,
  pendingSuggestedTasksInteraction,
  staleTargetRequestConfirmationInteraction,
  rejectedSuggestedTasksInteraction,
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

  it("requires a decline reason when the request confirmation payload asks for one", async () => {
    const onRejectInteraction = vi.fn(async () => undefined);
    const host = renderCard({
      interaction: pendingRequestConfirmationInteraction,
      onRejectInteraction,
    });

    const declineButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Request revisions"),
    );
    expect(declineButton).toBeTruthy();

    await act(async () => {
      declineButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const saveButton = Array.from(host.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes("Request revisions"),
    ).at(-1);
    expect(saveButton?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(host.textContent).toContain("A decline reason is required.");

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
    const enabledSaveButton = Array.from(host.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes("Request revisions"),
    ).at(-1);
    expect(enabledSaveButton?.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      enabledSaveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

    const declineButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Keep it"),
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

    const declineButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Request revisions"),
    );
    await act(async () => {
      declineButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

    const saveButton = Array.from(host.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes("Request revisions"),
    ).at(-1);
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRejectInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "request_confirmation" }),
      "![bug.png](https://cdn.example/shot.png)",
    );
  });
});
