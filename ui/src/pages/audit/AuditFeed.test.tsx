// @vitest-environment jsdom

import { flushSync } from "react-dom";
import type { ReactNode } from "react";
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
    listAgentActionsMock.mockResolvedValue({ items: [record()], nextCursor: null });
    listAgentsMock.mockResolvedValue([{ id: "agent-1", name: "Fable", icon: null }]);
    listUserDirectoryMock.mockResolvedValue({
      users: [{ principalId: "user-1", status: "active", user: { id: "user-1", name: "Dotta", email: null, image: null } }],
    });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(props: { companyId?: string; lockedAgentId?: string } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AuditFeed companyId={props.companyId ?? "company-1"} lockedAgentId={props.lockedAgentId} />
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

  it("renders the humanized sentence, the task link, the excerpt, and the on-behalf chip", async () => {
    await render();

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

  it("hides the agent filter and pins the query when lockedAgentId is set", async () => {
    await render({ lockedAgentId: "agent-1" });

    const [, filters] = listAgentActionsMock.mock.calls[0];
    expect((filters as { agentId?: string }).agentId).toBe("agent-1");
    // No "All agents" option means the agent filter is hidden on the per-agent tab.
    expect(container.textContent).not.toContain("All agents");
  });

  it("loads more when a cursor is returned", async () => {
    listAgentActionsMock.mockImplementation((_companyId: string, filters: { cursor?: string }) => {
      if (filters.cursor === "cursor-2") {
        return Promise.resolve({ items: [record({ id: "evt-2", entity: { issue: { id: "i2", identifier: "PAP-2", title: "Second" }, comment: null, document: null } })], nextCursor: null });
      }
      return Promise.resolve({ items: [record()], nextCursor: "cursor-2" });
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

    await clickButton("Export CSV");
    await flushReact();

    expect(exportCsvMock).toHaveBeenCalledWith("company-1", expect.any(Object));
    expect(createUrl).toHaveBeenCalled();
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
  });
});
