// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptedAutomationProposalFixture,
  acceptedAutomationResponseFixture,
  AUTOMATION_FIXTURE_ISSUE_ID,
  AUTOMATION_FIXTURE_WEBHOOK_SECRET,
  AUTOMATION_FIXTURE_WEBHOOK_URL,
  automationProposalFixture,
  type AutomationProposalTriggerKind,
} from "../../../storybook/fixtures/automation-proposals";
import { AutomationProposalCard } from "./AutomationProposalCard";

const acceptMock = vi.hoisted(() => vi.fn());
const declineMock = vi.hoisted(() => vi.fn());
const addCommentMock = vi.hoisted(() => vi.fn());
const getAgentMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/automation-conversations", () => ({
  automationConversationsApi: {
    accept: (...args: unknown[]) => acceptMock(...args),
    decline: (...args: unknown[]) => declineMock(...args),
  },
}));
vi.mock("@/api/issues", () => ({ issuesApi: { addComment: (...args: unknown[]) => addCommentMock(...args) } }));
vi.mock("@/api/agents", () => ({ agentsApi: { get: (...args: unknown[]) => getAgentMock(...args) } }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AutomationProposalCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    getAgentMock.mockResolvedValue({ id: "agent-codex", name: "CodexCoder" });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    acceptMock.mockReset();
    declineMock.mockReset();
    addCommentMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  let client: QueryClient;

  async function render(node: ReactNode) {
    client ??= new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  function button(label: string) {
    const match = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
    if (!match) throw new Error(`No button ${label}`);
    return match;
  }

  it.each<[AutomationProposalTriggerKind, string[]]>([
    ["schedule", ["Send the monthly investor update", "On a schedule: On the 1st of every month at 9 AM", "Seed extension and LP updates"]],
    ["webhook", ["From a webhook, when another system calls it", "Called by: The shared inbox, each time an email from an investor arrives", "you get the address to call and its secret"]],
    ["standing_check", ["A standing check: each time CodexCoder wakes up", "Looks for: An LP who has waited more than a week", "When it finds it: Draft the reply", "No responsibility: the task is not filed under one."]],
  ])("reads a %s proposal in plain words: what runs, how it starts, who runs it and where it is filed", async (kind, expected) => {
    await render(<AutomationProposalCard interaction={automationProposalFixture(kind)} />);
    const text = container.textContent ?? "";
    expect(text).toContain("CodexCoder proposed an automation for");
    expect(text).toContain("Who runs itCodexCoder");
    for (const part of expected) expect(text).toContain(part);
    expect(text).not.toMatch(/\b(issue|interaction|cron|trigger)\b/i);
    expect(container.querySelector("[data-testid='automation-proposal']")?.getAttribute("data-trigger")).toBe(kind);
  });

  it("sets up the automation with one tap", async () => {
    acceptMock.mockResolvedValue(acceptedAutomationResponseFixture("schedule"));
    await render(<AutomationProposalCard interaction={automationProposalFixture("schedule")} />);
    await act(async () => button("Set it up").click());
    expect(acceptMock).toHaveBeenCalledWith(AUTOMATION_FIXTURE_ISSUE_ID, "automation-proposal-schedule", expect.any(String));
  });

  it("after a webhook is set up, shows the address and the secret once, and later only how it is secured", async () => {
    acceptMock.mockResolvedValue(acceptedAutomationResponseFixture("webhook"));
    await render(<AutomationProposalCard interaction={automationProposalFixture("webhook")} />);
    await act(async () => button("Set it up").click());
    // The conversation's cache turns the same card accepted in place.
    await render(<AutomationProposalCard interaction={acceptedAutomationProposalFixture("webhook")} />);
    const fields = [...container.querySelectorAll<HTMLInputElement>("input")].map((input) => [input.getAttribute("aria-label"), input.value]);
    expect(fields).toEqual([["Address to call", AUTOMATION_FIXTURE_WEBHOOK_URL], ["Secret", AUTOMATION_FIXTURE_WEBHOOK_SECRET]]);
    expect(container.textContent).toContain("Save the secret now: it is shown only this once.");

    // Opened again later: the address and how it is secured, never the secret.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(<AutomationProposalCard interaction={acceptedAutomationProposalFixture("webhook")} />);
    expect([...container.querySelectorAll<HTMLInputElement>("input")].map((input) => input.value)).toEqual([AUTOMATION_FIXTURE_WEBHOOK_URL]);
    expect(container.textContent).toContain("Authorization: Bearer <secret>");
    expect(container.textContent).toContain("The secret was shown once");
    expect(container.textContent).toContain("Automation set up: Answer a new investor email · When another system calls it");
  });

  it("not right: closes the card and tells the agent what to change", async () => {
    declineMock.mockResolvedValue(automationProposalFixture("schedule", { status: "rejected", result: { version: 1, outcome: "declined" } }));
    addCommentMock.mockResolvedValue({ id: "comment" });
    await render(<AutomationProposalCard interaction={automationProposalFixture("schedule")} />);
    await act(async () => button("Not right").click());
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Send it on the 5th instead");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Send").click());
    expect(declineMock).toHaveBeenCalledWith(AUTOMATION_FIXTURE_ISSUE_ID, "automation-proposal-schedule");
    expect(addCommentMock).toHaveBeenCalledWith(AUTOMATION_FIXTURE_ISSUE_ID, "Send it on the 5th instead", true);
  });

  it("reads closed and replaced proposals quietly", async () => {
    await render(<AutomationProposalCard interaction={automationProposalFixture("schedule", { status: "rejected", result: { version: 1, outcome: "declined" } })} />);
    expect(container.textContent).toBe("Not this automation: Send the monthly investor update (On the 1st of every month at 9 AM)");
    await render(<AutomationProposalCard interaction={automationProposalFixture("schedule", { status: "expired", result: { version: 1, outcome: "replaced" } })} />);
    expect(container.textContent).toContain("replaced by a newer one");
  });
});
