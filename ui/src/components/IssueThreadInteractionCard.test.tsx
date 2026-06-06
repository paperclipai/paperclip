// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueThreadInteractionCard } from "./IssueThreadInteractionCard";
import { ThemeProvider } from "../context/ThemeContext";
import { TooltipProvider } from "./ui/tooltip";
import {
  acceptedManyRequestCheckboxConfirmationInteraction,
  boundedRequestCheckboxConfirmationInteraction,
  pendingAskUserQuestionsInteraction,
  commentExpiredRequestConfirmationInteraction,
  disabledDeclineReasonRequestConfirmationInteraction,
  failedRequestConfirmationInteraction,
  manyOptionsRequestCheckboxConfirmationInteraction,
  pendingRequestCheckboxConfirmationInteraction,
  pendingRequestConfirmationInteraction,
  pendingSuggestedTasksInteraction,
  staleTargetRequestCheckboxConfirmationInteraction,
  staleTargetRequestConfirmationInteraction,
  rejectedSuggestedTasksInteraction,
} from "../fixtures/issueThreadInteractionFixtures";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

  it("labels accept-only continuation policies in the card header", () => {
    const host = renderCard({
      interaction: {
        ...pendingRequestConfirmationInteraction,
        continuationPolicy: "wake_assignee_on_accept",
      },
    });

    expect(host.textContent).toContain("Wakes on confirm");
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

  it("exposes pending checkbox options with select-all and clear controls", () => {
    const host = renderCard({
      interaction: pendingRequestCheckboxConfirmationInteraction,
      onAcceptInteraction: vi.fn(),
    });

    const checkboxes = [...host.querySelectorAll('[role="checkbox"]')];
    expect(checkboxes).toHaveLength(
      pendingRequestCheckboxConfirmationInteraction.payload.options.length,
    );
    expect(checkboxes[0]?.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("0 of 4 options selected");

    const selectAll = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent === "Select all",
    );
    act(() => {
      selectAll?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.textContent).toContain("All 4 options selected");

    const clear = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent === "Clear selection",
    );
    act(() => {
      clear?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.textContent).toContain("0 of 4 options selected");
  });

  it("submits selected option ids on accept", async () => {
    const onAcceptInteraction = vi.fn(async () => undefined);
    const host = renderCard({
      interaction: pendingRequestCheckboxConfirmationInteraction,
      onAcceptInteraction,
    });

    const checkboxes = [...host.querySelectorAll('[role="checkbox"]')];
    await act(async () => {
      (checkboxes[0] as HTMLButtonElement).click();
      (checkboxes[2] as HTMLButtonElement).click();
    });

    const confirmButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Delete selected"),
    );
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAcceptInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "request_checkbox_confirmation" }),
      undefined,
      ["draft-march-report", "draft-scratch-notes"],
    );
  });

  it("blocks accept until the minimum selection is met", async () => {
    const onAcceptInteraction = vi.fn(async () => undefined);
    const host = renderCard({
      interaction: {
        ...boundedRequestCheckboxConfirmationInteraction,
        payload: {
          ...boundedRequestCheckboxConfirmationInteraction.payload,
          defaultSelectedOptionIds: [],
        },
      },
      onAcceptInteraction,
    });

    const confirmButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Confirm regions"),
    );
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAcceptInteraction).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Select at least 2 options.");
  });

  it("disables remaining checkboxes once the max selection is reached", () => {
    const host = renderCard({
      interaction: boundedRequestCheckboxConfirmationInteraction,
      onAcceptInteraction: vi.fn(),
    });

    // Defaults select us-west + us-east; bumping to the 3-item max should lock the rest.
    const checkboxes = [...host.querySelectorAll('[role="checkbox"]')] as HTMLButtonElement[];
    const unchecked = checkboxes.filter((box) => box.getAttribute("aria-checked") === "false");
    act(() => {
      unchecked[0]?.click();
    });

    const stillUnchecked = ([...host.querySelectorAll('[role="checkbox"]')] as HTMLButtonElement[])
      .filter((box) => box.getAttribute("aria-checked") === "false");
    expect(stillUnchecked.length).toBeGreaterThan(0);
    expect(stillUnchecked.every((box) => box.hasAttribute("disabled"))).toBe(true);

    const selectAllButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Select all"),
    );
    expect(selectAllButton?.hasAttribute("disabled")).toBe(true);
  });

  it("summarizes large accepted selections by count and bounds the chips", () => {
    const host = renderCard({
      interaction: acceptedManyRequestCheckboxConfirmationInteraction,
    });

    expect(host.textContent).toContain("Confirmed 42 of 100 options");
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
    // 42 selected, but only the first 8 labels render inline, then a "+N more" chip.
    expect(host.textContent).toContain("+34 more");
  });

  it("stays compact and scrollable with around 100 options", () => {
    const host = renderCard({
      interaction: manyOptionsRequestCheckboxConfirmationInteraction,
      onAcceptInteraction: vi.fn(),
    });

    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(100);
    const scrollRegion = host.querySelector('[aria-label="Selectable options"]');
    expect(scrollRegion?.className).toContain("max-h-80");
    expect(scrollRegion?.className).toContain("overflow-y-auto");
  });

  it("renders stale-target expiry for checkbox confirmations", () => {
    const host = renderCard({
      interaction: staleTargetRequestCheckboxConfirmationInteraction,
    });

    expect(host.textContent).toContain("Expired by target change");
    expect(host.textContent).toContain("Plan v3");
    expect(host.textContent).toContain("Plan v4");
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
  });
});
