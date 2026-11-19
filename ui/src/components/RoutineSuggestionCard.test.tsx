// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SuggestRoutineInteraction } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineSuggestionCard } from "./RoutineSuggestionCard";

const acceptMock = vi.hoisted(() => vi.fn());
const declineMock = vi.hoisted(() => vi.fn());
const getAgentMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/routine-suggestions", () => ({
  routineSuggestionsApi: {
    accept: (...args: unknown[]) => acceptMock(...args),
    decline: (...args: unknown[]) => declineMock(...args),
  },
}));
vi.mock("@/api/agents", () => ({ agentsApi: { get: (...args: unknown[]) => getAgentMock(...args) } }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function offer(overrides: Partial<SuggestRoutineInteraction> = {}): SuggestRoutineInteraction {
  return {
    id: "offer-1",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "suggest_routine",
    status: "pending",
    continuationPolicy: "none",
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    title: 'Repeat "Weekly pricing summary"?',
    summary: "Every Monday at 9 AM",
    resolverPolicy: "human_only",
    requestedResolverPolicy: "human_only",
    effectiveResolverPolicy: "human_only",
    resolverPolicyProvenance: "explicit",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: { requested: "board_only", effective: "board_only" },
    createdAt: "2026-11-13T10:00:00.000Z",
    updatedAt: "2026-11-13T10:00:00.000Z",
    payload: {
      version: 1,
      title: "Weekly pricing summary",
      instructions: "Summarize competitor pricing changes.",
      message: "Want this every week?",
      cadence: { frequency: "weekly", dayOfWeek: "monday", dayOfMonth: null, time: "09:00" },
      cadenceLabel: "Every Monday at 9 AM",
      cronExpression: "0 9 * * 1",
      assigneeAgentId: "agent-1",
      projectId: null,
    },
    result: null,
    ...overrides,
  } as SuggestRoutineInteraction;
}

describe("RoutineSuggestionCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    getAgentMock.mockResolvedValue({ id: "agent-1", name: "Analyst" });
    acceptMock.mockReset();
    declineMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(interaction: SuggestRoutineInteraction) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <RoutineSuggestionCard interaction={interaction} />
        </QueryClientProvider>,
      );
    });
    // Let the agent lookup settle.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  function button(label: string) {
    const match = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label));
    if (!match) throw new Error(`No button ${label}`);
    return match;
  }

  it("reads as the agent's offer with what repeats and when", async () => {
    await render(offer());
    const text = container.textContent ?? "";
    expect(text).toContain("Analyst");
    expect(text).toContain("Want this every week?");
    expect(text).toContain("Weekly pricing summary");
    expect(text).toContain("Every Monday at 9 AM");
    expect(text).not.toMatch(/\bissue\b/i);
  });

  it("accepts in one tap with the person's time zone", async () => {
    acceptMock.mockResolvedValue({ interaction: offer({ status: "accepted" }), routine: { id: "routine-1" } });
    await render(offer());
    await act(async () => { button("Make it a routine").click(); });
    expect(acceptMock).toHaveBeenCalledWith("issue-1", "offer-1", expect.any(String));
    expect(declineMock).not.toHaveBeenCalled();
  });

  it("declines quietly", async () => {
    declineMock.mockResolvedValue(offer({ status: "rejected" }));
    await render(offer());
    await act(async () => { button("No thanks").click(); });
    expect(declineMock).toHaveBeenCalledWith("issue-1", "offer-1");
  });

  it("confirms an accepted offer with a link to the routine", async () => {
    await render(offer({
      status: "accepted",
      result: { version: 1, outcome: "accepted", routineId: "routine-1", routineTitle: "Weekly pricing summary", cadenceLabel: "Every Monday at 9 AM" },
    }));
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/routines/routine-1");
    expect(container.textContent).toContain("Routine set up");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("leaves nothing behind once declined or withdrawn", async () => {
    await render(offer({ status: "rejected", result: { version: 1, outcome: "declined" } }));
    expect(container.textContent).toBe("");
    await render(offer({ status: "expired", result: { version: 1, outcome: "issue_closed" } }));
    expect(container.textContent).toBe("");
  });
});
