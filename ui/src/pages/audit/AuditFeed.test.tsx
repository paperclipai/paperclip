// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { AuditFeed } from "./AuditFeed";

const listAgentActionsMock = vi.hoisted(() => vi.fn());
const exportCsvMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const listUserDirectoryMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/audit", () => ({
  auditApi: {
    listAgentActions: (companyId: string, filters: unknown) => listAgentActionsMock(companyId, filters),
    exportAgentActionsCsv: (companyId: string, filters: unknown) => exportCsvMock(companyId, filters),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { list: (companyId: string) => listAgentsMock(companyId) },
}));

vi.mock("@/api/access", () => ({
  accessApi: { listUserDirectory: (companyId: string) => listUserDirectoryMock(companyId) },
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: pushToastMock }),
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

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    companyId: "company-1",
    actorType: "agent",
    actorId: "agent-1",
    action: "issue.comment_added",
    entityType: "issue",
    entityId: "issue-1",
    agentId: "agent-1",
    runId: "run-1",
    responsibleUserId: "user-1",
    details: { commentId: "c1" },
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    entity: {
      issue: { id: "issue-1", identifier: "PAP-1", title: "Ship the audit UI" },
      comment: { id: "c1", excerpt: "Looks good to me" },
      document: null,
    },
    ...overrides,
  };
}

describe("AuditFeed", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listAgentActionsMock.mockResolvedValue({ items: [record()], nextCursor: null, accessTier: "full" });
    listAgentsMock.mockResolvedValue([{ id: "agent-1", name: "Fable", icon: null }]);
    listUserDirectoryMock.mockResolvedValue({
      users: [{ principalId: "user-1", status: "active", user: { id: "user-1", name: "Dotta", email: null, image: null } }],
    });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function render(
    props: {
      companyId?: string;
      lockedAgentId?: string;
      mode?: "all" | "agents";
      onModeChange?: (mode: "all" | "agents") => void;
    } = {},
  ) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AuditFeed
            companyId={props.companyId ?? "company-1"}
            lockedAgentId={props.lockedAgentId}
            mode={props.mode}
            onModeChange={props.onModeChange}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return client;
  }

  /** Poll until `text` renders, for states that settle behind query retry backoff. */
  async function waitForText(text: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (container.textContent?.includes(text)) return;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 25));
      });
    }
    expect(container.textContent, `waiting for "${text}"`).toContain(text);
  }

  function clickButton(text: string) {
    const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
    expect(btn, `button "${text}"`).toBeTruthy();
    return act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  /** Radix tabs activate on mousedown, so drive both events like a real click. */
  function clickTab(label: string) {
    const tab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (el) => el.textContent?.trim() === label,
    );
    expect(tab, `tab "${label}"`).toBeTruthy();
    return act(async () => {
      tab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      tab!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
  }

  it("renders the humanized sentence, the task link, the excerpt, and the on-behalf chip", async () => {
    await render();

    expect(listAgentActionsMock).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ actorScope: "all" }),
    );
    expect(container.textContent).toContain("Fable");
    expect(container.textContent).toContain("commented on");
    const taskLink = container.querySelector('a[href="/issues/PAP-1"]');
    expect(taskLink?.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("Looks good to me");
    expect(container.textContent).toContain("on behalf of Dotta");
    expect(container.querySelector('a[href="/agents/agent-1/runs/run-1"]')).toBeTruthy();
    expect(container.textContent).toContain("Recorded by Paperclip");
  });

  it("shows the permission-denied upsell when the feed 403s", async () => {
    listAgentActionsMock.mockRejectedValue(
      new ApiError("Missing permission: audit:view_agent_actions", 403, { error: "Missing permission" }),
    );
    await render();

    expect(container.textContent).toContain("Paperclip Enterprise view");
    expect(container.textContent).toContain("audit:view_agent_actions");
    // The feed chrome (filters, footer) is not rendered in the denied state.
    expect(container.textContent).not.toContain("Recorded by Paperclip");
  });

  it("hides attribution filters and export for a basic all-actors reader", async () => {
    listAgentActionsMock.mockResolvedValue({ items: [record()], nextCursor: null, accessTier: "basic" });
    await render();

    expect(container.textContent).toContain("commented on");
    expect(container.textContent).not.toContain("All agents");
    expect(container.textContent).not.toContain("All responsible users");
    expect(container.textContent).not.toContain("Export CSV");
  });

  it("clears privileged filters and recovers the basic feed after an access downgrade", async () => {
    let permissionRevoked = false;
    listAgentActionsMock.mockImplementation((_companyId: string, filters: { from?: string }) => {
      if (permissionRevoked && filters.from) {
        return Promise.reject(
          new ApiError("Missing permission: audit:view_agent_actions", 403, { error: "Missing permission" }),
        );
      }
      return Promise.resolve({
        items: [record()],
        nextCursor: null,
        accessTier: permissionRevoked ? "basic" : "full",
      });
    });
    await render();

    const fromDate = container.querySelector<HTMLInputElement>('input[aria-label="From date"]');
    expect(fromDate).toBeTruthy();
    const setInputValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    expect(setInputValue).toBeTruthy();
    await act(async () => {
      permissionRevoked = true;
      setInputValue!.call(fromDate, "2026-08-01");
      fromDate!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    expect(listAgentActionsMock.mock.calls.some(([, filters]) => filters.from)).toBe(true);
    expect(listAgentActionsMock.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ actorScope: "all", from: undefined }),
    );
    expect(container.textContent).toContain("commented on");
    expect(container.textContent).not.toContain("Paperclip Enterprise view");
    expect(container.textContent).not.toContain("All agents");
    expect(container.textContent).not.toContain("Export CSV");
  });

  it("drops cached privileged pages when pagination observes an access downgrade", async () => {
    let permissionRevoked = false;
    listAgentActionsMock.mockImplementation((_companyId: string, filters: { cursor?: string }) => {
      if (filters.cursor === "cursor-2") {
        return Promise.resolve({
          items: [record({
            id: "evt-2",
            agentId: null,
            runId: null,
            responsibleUserId: null,
            details: null,
          })],
          nextCursor: null,
          accessTier: "basic",
        });
      }
      if (permissionRevoked) {
        return Promise.resolve({
          items: [record({ agentId: null, runId: null, responsibleUserId: null, details: null })],
          nextCursor: null,
          accessTier: "basic",
        });
      }
      return Promise.resolve({ items: [record()], nextCursor: "cursor-2", accessTier: "full" });
    });
    await render();

    expect(container.textContent).toContain("on behalf of Dotta");
    expect(container.textContent).toContain("Export CSV");
    permissionRevoked = true;
    await clickButton("Load more");
    await flushReact();

    expect(listAgentActionsMock.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ actorScope: "all", cursor: undefined }),
    );
    expect(container.textContent).toContain("commented on");
    expect(container.textContent).not.toContain("on behalf of Dotta");
    expect(container.querySelector('a[href="/agents/agent-1/runs/run-1"]')).toBeFalsy();
    expect(container.textContent).not.toContain("All agents");
    expect(container.textContent).not.toContain("Export CSV");
  });

  it("surfaces the retry UI when the access-downgrade recovery refetch fails", async () => {
    // The downgrade recovery refetch can itself fail. React Query keeps the
    // cached mixed-tier pages on failure, so without a guard the feed sits on
    // "Refreshing audit access…" forever with no way out.
    let downgraded = false;
    let calls = 0;
    listAgentActionsMock.mockImplementation((_companyId: string, filters: { cursor?: string }) => {
      calls += 1;
      if (filters.cursor === "cursor-2") {
        downgraded = true;
        return Promise.resolve({
          items: [record({ id: "evt-2", agentId: null, runId: null, responsibleUserId: null, details: null })],
          nextCursor: null,
          accessTier: "basic",
        });
      }
      if (downgraded) return Promise.reject(new Error("Network down"));
      return Promise.resolve({ items: [record()], nextCursor: "cursor-2", accessTier: "full" });
    });
    await render();
    await clickButton("Load more");
    // The feed retries twice with backoff (~3s) before the query settles as
    // errored, and it stays "fetching" throughout — so wait for the settled
    // state rather than a fixed number of microtask flushes. The explicit test
    // timeout below keeps that wait inside the budget on slower CI runners.
    await waitForText("Try again", 20_000);

    expect(container.textContent).not.toContain("Refreshing audit access…");
    expect(container.textContent).toContain("Network down");
    expect(container.textContent).toContain("Try again");

    // And the recovery must not loop: no further refetches once it has failed.
    const settledCalls = calls;
    await flushReact();
    expect(calls).toBe(settledCalls);
  }, 30_000);

  it("renders the feed when the recovery refetch cannot clear the mixed tiers", async () => {
    // Pathological but reachable: the refetch succeeds and still returns one
    // full page plus one basic page. The recovery has had its shot, so the feed
    // must render at the least-privileged tier instead of sitting on the banner.
    listAgentActionsMock.mockImplementation((_companyId: string, filters: { cursor?: string }) =>
      filters.cursor === "cursor-2"
        ? Promise.resolve({
            items: [record({ id: "evt-2", agentId: null, runId: null, responsibleUserId: null, details: null })],
            nextCursor: null,
            accessTier: "basic",
          })
        : Promise.resolve({ items: [record()], nextCursor: "cursor-2", accessTier: "full" }),
    );
    await render();
    await clickButton("Load more");
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("Refreshing audit access…");
    expect(container.textContent).toContain("commented on");
    // Least-privileged page wins, so the privileged chrome stays hidden.
    expect(container.textContent).not.toContain("Export CSV");
    // And the cached full-tier page must not render revoked attribution beside
    // the stripped rows just because the recovery has run out of attempts.
    expect(container.textContent).not.toContain("on behalf of Dotta");
    expect(container.querySelector('a[href="/agents/agent-1/runs/run-1"]')).toBeFalsy();

    const settledCalls = listAgentActionsMock.mock.calls.length;
    await flushReact();
    expect(listAgentActionsMock.mock.calls.length).toBe(settledCalls);
  });

  it("hides the agent filter and pins the query when lockedAgentId is set", async () => {
    await render({ lockedAgentId: "agent-1" });

    const [, filters] = listAgentActionsMock.mock.calls[0];
    expect(filters).toEqual(expect.objectContaining({ actorScope: "agents", agentId: "agent-1" }));
    // No "All agents" option means the agent filter is hidden on the per-agent tab.
    expect(container.textContent).not.toContain("All agents");
  });

  it("ignores the mode toggle on the per-agent tab", async () => {
    const onModeChange = vi.fn();
    await render({ lockedAgentId: "agent-1", mode: "all", onModeChange });

    expect(container.querySelector('[role="tab"]')).toBeFalsy();
    expect(listAgentActionsMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ actorScope: "agents", agentId: "agent-1" }),
    );
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("offers the agent-actions mode to a full-tier reader and requests the privileged scope", async () => {
    // Mirror the page: the mode lives above the feed, so toggling re-queries.
    function Harness() {
      const [mode, setMode] = useState<"all" | "agents">("all");
      return <AuditFeed companyId="company-1" mode={mode} onModeChange={setMode} />;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("All activity");
    expect(container.textContent).toContain("Agent actions");
    expect(listAgentActionsMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ actorScope: "all" }),
    );

    await clickTab("Agent actions");
    await flushReact();

    expect(listAgentActionsMock.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ actorScope: "agents" }),
    );
    // The privileged scope keeps the attribution filters and the export.
    expect(container.textContent).toContain("All responsible users");
    expect(container.textContent).toContain("Export CSV");
  });

  it("resolves a basic-tier agent name from the company-readable actorId", async () => {
    // The basic tier nulls privileged attribution but retains the acting
    // principal, which is also available through the company agent directory.
    listAgentActionsMock.mockResolvedValue({
      items: [record({ agentId: null, runId: null, responsibleUserId: null, details: null })],
      nextCursor: null,
      accessTier: "basic",
    });
    await render({ mode: "all", onModeChange: vi.fn() });

    expect(container.textContent).toContain("Fable");
    expect(container.textContent).not.toContain("Agent commented");
    expect(container.textContent).not.toContain("System");
  });

  it("falls back to the actor type when an agent is absent from the readable directory", async () => {
    listAgentActionsMock.mockResolvedValue({
      items: [record({ actorId: "filtered-agent", agentId: null, runId: null, responsibleUserId: null, details: null })],
      nextCursor: null,
      accessTier: "basic",
    });
    await render({ mode: "all", onModeChange: vi.fn() });

    expect(container.textContent).toContain("Agent");
    expect(container.textContent).not.toContain("System");
  });

  it("hides the mode toggle from a basic all-actors reader", async () => {
    listAgentActionsMock.mockResolvedValue({ items: [record()], nextCursor: null, accessTier: "basic" });
    await render({ mode: "all", onModeChange: vi.fn() });

    expect(container.querySelector('[role="tab"]')).toBeFalsy();
    expect(container.textContent).not.toContain("Agent actions");
    // The basic feed itself still renders.
    expect(container.textContent).toContain("commented on");
  });

  it("falls back to all-activity instead of the upsell when a basic reader opens the agent-actions mode", async () => {
    listAgentActionsMock.mockRejectedValue(
      new ApiError("Missing permission: audit:view_agent_actions", 403, { error: "Missing permission" }),
    );
    const onModeChange = vi.fn();
    await render({ mode: "agents", onModeChange });

    expect(onModeChange).toHaveBeenCalledWith("all");
    expect(container.textContent).not.toContain("Paperclip Enterprise view");
    expect(container.textContent).toContain("Refreshing audit access…");
  });

  it("still upsells an uncontrolled agent-actions feed that 403s", async () => {
    listAgentActionsMock.mockRejectedValue(
      new ApiError("Missing permission: audit:view_agent_actions", 403, { error: "Missing permission" }),
    );
    await render({ mode: "agents" });

    expect(container.textContent).toContain("Paperclip Enterprise view");
  });

  it("only offers action domains present in the agent-action feed", async () => {
    await render();

    await clickButton("All actions");
    expect(document.body.textContent).toContain("Tasks");
    expect(document.body.textContent).not.toContain("Audit exports");
  });

  it("loads more when a cursor is returned", async () => {
    listAgentActionsMock.mockImplementation((_companyId: string, filters: { cursor?: string }) => {
      if (filters.cursor === "cursor-2") {
        return Promise.resolve({ items: [record({ id: "evt-2", entity: { issue: { id: "i2", identifier: "PAP-2", title: "Second" }, comment: null, document: null } })], nextCursor: null, accessTier: "full" });
      }
      return Promise.resolve({ items: [record()], nextCursor: "cursor-2", accessTier: "full" });
    });
    await render();

    expect(container.querySelector('a[href="/issues/PAP-2"]')).toBeFalsy();
    await clickButton("Load more");
    await flushReact();
    expect(container.querySelector('a[href="/issues/PAP-2"]')).toBeTruthy();
  });

  it("exports CSV and toasts on success", async () => {
    exportCsvMock.mockResolvedValue(new Blob(["csv"], { type: "text/csv" }));
    // jsdom lacks URL.createObjectURL; stub it for the download path.
    const createUrl = vi.fn(() => "blob:mock");
    const revokeUrl = vi.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createUrl;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeUrl;
    await render();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");

    await clickButton("Export CSV");
    await flushReact();

    expect(exportCsvMock).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ actorScope: "all" }),
    );
    expect(createUrl).toHaveBeenCalled();
    expect(revokeUrl).not.toHaveBeenCalled();
    const deferredRevoke = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 5_000)?.[0];
    expect(deferredRevoke).toEqual(expect.any(Function));
    deferredRevoke!();
    expect(revokeUrl).toHaveBeenCalledWith("blob:mock");
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
  });
});
