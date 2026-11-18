// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ResponsibilityMetricKind } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { barProposalFixture } from "../../../storybook/fixtures/responsibility-bars";
import { BarProposalCard } from "./BarProposalCard";

const acceptMock = vi.hoisted(() => vi.fn());
const declineMock = vi.hoisted(() => vi.fn());
const addCommentMock = vi.hoisted(() => vi.fn());
const getAgentMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/responsibility-bars", () => ({
  responsibilityBarsApi: {
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

describe("BarProposalCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    getAgentMock.mockResolvedValue({ id: "agent-cto", name: "Chief of staff" });
    acceptMock.mockReset();
    declineMock.mockReset();
    addCommentMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(node: ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

  it.each<[ResponsibilityMetricKind, string[]]>([
    ["volume", ["Volume", "At most 0", "3 of the 11 open escalations", "On track at 0 or less; behind above that", "Behind"]],
    ["percentage", ["Percentage", "At least 90%", "79%", "On track at 90% or more; at risk from 68%", "At risk"]],
    ["yes_no", ["Yes or no", "Board pack sent a week before the next meeting", "On track when the answer is yes; behind when it is no"]],
    ["range", ["Range", "Between 12 and 24 months", "10 months", "at risk up to 3 months outside it"]],
  ])("reads a %s bar in plain words", async (kind, expected) => {
    const interaction = barProposalFixture(kind);
    await render(<BarProposalCard interaction={interaction} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Chief of staff proposed a bar for");
    expect(text).toContain(interaction.payload.bar.standard);
    for (const part of expected) expect(text).toContain(part);
    expect(text).not.toMatch(/\b(issue|interaction|metricKind)\b/i);
    // Without a reading there is no reading row and no status preview.
    if (kind === "yes_no") {
      expect(text).not.toContain("Where it is now");
      expect(text).not.toContain("Status with it");
    }
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/responsibilities/resp-fundraising");
  });

  it("applies the bar in one tap", async () => {
    acceptMock.mockResolvedValue({ interaction: barProposalFixture("range", { status: "accepted" }), responsibility: {} });
    await render(<BarProposalCard interaction={barProposalFixture("range")} />);
    await act(async () => { button("Use this bar").click(); });
    expect(acceptMock).toHaveBeenCalledExactlyOnceWith("issue-bar-conversation", "bar-proposal-range");
    expect(declineMock).not.toHaveBeenCalled();
  });

  it("says it is not right, then tells the agent what to change in the conversation", async () => {
    declineMock.mockResolvedValue(barProposalFixture("percentage", { status: "rejected" }));
    addCommentMock.mockResolvedValue({ id: "comment-1" });
    await render(<BarProposalCard interaction={barProposalFixture("percentage")} />);
    await act(async () => { button("Not right").click(); });
    const reason = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(reason, "Count only LPs we met this year");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button("Send").click(); });
    expect(declineMock).toHaveBeenCalledExactlyOnceWith("issue-bar-conversation", "bar-proposal-percentage");
    expect(addCommentMock).toHaveBeenCalledExactlyOnceWith("issue-bar-conversation", "Count only LPs we met this year", true);
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("sends a plain line when the person gives no reason", async () => {
    declineMock.mockResolvedValue(barProposalFixture("volume", { status: "rejected" }));
    addCommentMock.mockResolvedValue({ id: "comment-1" });
    await render(<BarProposalCard interaction={barProposalFixture("volume")} />);
    await act(async () => { button("Not right").click(); });
    await act(async () => { button("Send").click(); });
    expect(addCommentMock).toHaveBeenCalledWith("issue-bar-conversation", "That bar isn't right yet.", true);
  });

  it("links to the conversation on the responsibility's page", async () => {
    await render(<BarProposalCard interaction={barProposalFixture("percentage")} showConversationLink showResponsibilityLink={false} />);
    const links = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(links).toEqual(["/issues/issue-bar-conversation"]);
  });

  it("settles to one line once accepted, declined or replaced, and to nothing when withdrawn", async () => {
    await render(<BarProposalCard interaction={barProposalFixture("range", {
      status: "accepted", result: { version: 1, outcome: "accepted", responsibilityId: "resp-fundraising" },
    })} />);
    expect(container.textContent).toContain("Bar set for Runway: We always have between 12 and 24 months of runway.");
    expect(container.querySelectorAll("button")).toHaveLength(0);

    await render(<BarProposalCard interaction={barProposalFixture("range", { status: "rejected", result: { version: 1, outcome: "declined" } })} />);
    expect(container.textContent).toContain("Not this bar:");

    await render(<BarProposalCard interaction={barProposalFixture("range", {
      status: "expired", result: { version: 1, outcome: "replaced", replacedByInteractionId: "x" },
    })} />);
    expect(container.textContent).toContain("replaced by a newer one");

    await render(<BarProposalCard interaction={barProposalFixture("range", { status: "expired", result: { version: 1, outcome: "issue_closed" } })} />);
    expect(container.textContent).toBe("");
  });
});
