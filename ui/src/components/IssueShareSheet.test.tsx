// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueAccessGrant } from "@paperclipai/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

const listAccessGrants = vi.fn();
const createAccessGrant = vi.fn();
const revokeAccessGrant = vi.fn();

vi.mock("@/api/issues", () => ({
  issuesApi: {
    listAccessGrants: (...args: unknown[]) => listAccessGrants(...args),
    createAccessGrant: (...args: unknown[]) => createAccessGrant(...args),
    revokeAccessGrant: (...args: unknown[]) => revokeAccessGrant(...args),
  },
}));
vi.mock("@/api/access", () => ({
  accessApi: { listUserDirectory: vi.fn().mockResolvedValue({ users: [] }) },
}));
vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

import { IssueShareSheet } from "./IssueShareSheet";

function grant(overrides: Partial<IssueAccessGrant>): IssueAccessGrant {
  return {
    id: "g",
    issueId: "i1",
    subjectType: "user",
    subjectId: "u1",
    source: "explicit",
    grantedByUserId: null,
    grantedByAgentId: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    revokedAt: null,
    subjectDisplayName: "Ada",
    subjectAvatarUrl: null,
    subjectInitials: "A",
    agentVisibility: null,
    ...overrides,
  };
}

// React Query resolves its mocked promises on the microtask/macrotask queue,
// outside flushSync. Interleave real awaits with flushSync to let the observer
// receive data and re-render.
async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }
}

describe("IssueShareSheet", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    listAccessGrants.mockReset();
    createAccessGrant.mockReset();
    revokeAccessGrant.mockReset();
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  async function renderSheet(canManage = true) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    act(() => {
      root!.render(
        <QueryClientProvider client={client}>
          <IssueShareSheet
            issueId="i1"
            companyId="c1"
            canManage={canManage}
            open
            onOpenChange={() => {}}
          />
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  it("renders a source badge per grant and gates Revoke by source", async () => {
    listAccessGrants.mockResolvedValue([
      grant({ id: "g1", source: "explicit", subjectDisplayName: "Ada" }),
      grant({ id: "g2", source: "assignment", subjectType: "agent", subjectId: "a1", subjectDisplayName: "Helper" }),
      grant({ id: "g3", source: "project", subjectDisplayName: "Proj User" }),
    ]);
    await renderSheet(true);

    // Body is portalled to document.body by Radix Dialog.
    const scope = document.body;
    expect(scope.querySelector('[data-testid="grant-source-badge-explicit"]')).not.toBeNull();
    expect(scope.querySelector('[data-testid="grant-source-badge-assignment"]')).not.toBeNull();
    expect(scope.querySelector('[data-testid="grant-source-badge-project"]')).not.toBeNull();

    const revokeButtons = [...scope.querySelectorAll("button")].filter((b) =>
      b.textContent?.trim() === "Revoke",
    );
    // explicit + assignment are revocable; project is not.
    expect(revokeButtons).toHaveLength(2);
    expect(scope.textContent).toContain("project-managed");
  });

  it("hides Revoke entirely for non-setters", async () => {
    listAccessGrants.mockResolvedValue([grant({ id: "g1", source: "explicit" })]);
    await renderSheet(false);
    const revokeButtons = [...document.body.querySelectorAll("button")].filter((b) =>
      b.textContent?.trim() === "Revoke",
    );
    expect(revokeButtons).toHaveLength(0);
  });

  it("shows the empty state when there are no grants", async () => {
    listAccessGrants.mockResolvedValue([]);
    await renderSheet(true);
    expect(document.body.querySelector('[data-testid="share-sheet-empty"]')?.textContent).toContain(
      "Only you can see this task",
    );
  });

  it("ignores revoked grants", async () => {
    listAccessGrants.mockResolvedValue([
      grant({ id: "g1", source: "explicit", revokedAt: new Date("2026-08-01T01:00:00Z") }),
    ]);
    await renderSheet(true);
    expect(document.body.querySelector('[data-testid="share-sheet-empty"]')).not.toBeNull();
  });
});
