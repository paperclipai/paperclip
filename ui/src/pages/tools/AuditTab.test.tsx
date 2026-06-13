// @vitest-environment jsdom

import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditTab } from "./AuditTab";

const listActivityMock = vi.hoisted(() => vi.fn());
const listApplicationsMock = vi.hoisted(() => vi.fn());
const listPoliciesMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listActivity: (companyId: string, params: unknown) => listActivityMock(companyId, params),
    listApplications: (companyId: string) => listApplicationsMock(companyId),
    listPolicies: (companyId: string) => listPoliciesMock(companyId),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => listAgentsMock(companyId),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    companyId: "company-1",
    action: "tool_gateway.call_denied",
    actorType: "agent",
    actorId: "agent-1",
    entityType: "issue",
    entityId: "run-1",
    agentId: "agent-1",
    runId: "run-1",
    applicationId: "app-1",
    connectionId: "conn-1",
    agentDisplayName: "Fable",
    appDisplayName: "Gmail",
    applicationDisplayName: "Gmail",
    connectionDisplayName: "Gmail",
    toolDisplayName: "Send Email",
    normalizedOutcome: "blocked",
    details: {
      reasonCode: "deny_policy_block",
      tool: "mail:send_email",
      issueId: "issue-1",
      runId: "run-1",
      matchedPolicyIds: ["pol-1"],
    },
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("AuditTab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listActivityMock.mockResolvedValue({ events: [event()], nextCursor: null });
    listApplicationsMock.mockResolvedValue({ applications: [{ id: "app-1", name: "Gmail" }] });
    listAgentsMock.mockResolvedValue([{ id: "agent-1", name: "Fable" }]);
    listPoliciesMock.mockResolvedValue({ policies: [{ id: "pol-1", name: "destructive actions → Block" }] });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AuditTab companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  function clickButton(text: string) {
    const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
    expect(btn, `button "${text}"`).toBeTruthy();
    return act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("renders humanized sentences, the outcome chip, and the footer note", async () => {
    await render();

    expect(container.textContent).toContain("Fable");
    expect(container.textContent).toContain("Send Email");
    expect(container.textContent).toContain("Gmail");
    expect(container.textContent).toContain("Blocked");
    expect(container.textContent).toContain("Recorded by Paperclip — entries can't be edited.");
    // Vocabulary gate: no raw tool ID or ops terms in the sentence list.
    expect(container.textContent).not.toContain("mail:send_email");
    expect(container.textContent).not.toContain("server-authoritative");
  });

  it("expands a row to show the plain reason, the linked rule, and the Details collapse", async () => {
    await render();

    await clickButton("used Send Email");
    await flushReact();

    expect(container.textContent).toContain("Blocked by a rule.");
    const ruleLink = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("destructive actions"),
    );
    expect(ruleLink?.getAttribute("href")).toBe("/apps/advanced/policies");

    // Raw tool name + reason code only appear once Details is opened.
    expect(container.textContent).not.toContain("mail:send_email");
    await clickButton("Details");
    await flushReact();
    expect(container.textContent).toContain("mail:send_email");
    expect(container.textContent).toContain("deny_policy_block");
  });

  it("shows the true-empty state when there is no activity", async () => {
    listActivityMock.mockResolvedValue({ events: [], nextCursor: null });
    await render();
    expect(container.textContent).toContain("Nothing here yet");
    // No active filters yet → no Clear filters button.
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Clear filters")).toBe(false);
  });

  it("loads more when a cursor is returned", async () => {
    listActivityMock.mockImplementation((_companyId: string, params: { cursor?: string }) => {
      if (params.cursor === "cursor-2") {
        return Promise.resolve({ events: [event({ id: "evt-2", toolDisplayName: "Read Email" })], nextCursor: null });
      }
      return Promise.resolve({ events: [event()], nextCursor: "cursor-2" });
    });
    await render();

    expect(container.textContent).not.toContain("Read Email");
    await clickButton("Load more");
    await flushReact();
    expect(container.textContent).toContain("Read Email");
  });
});
