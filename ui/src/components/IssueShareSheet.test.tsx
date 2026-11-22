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

const originalScrollIntoView = Element.prototype.scrollIntoView;
const listAccessGrants = vi.fn();
const createAccessGrant = vi.fn();
const revokeAccessGrant = vi.fn();
const listUserDirectory = vi.fn();

vi.mock("@/api/issues", () => ({
  issuesApi: {
    listAccessGrants: (...args: unknown[]) => listAccessGrants(...args),
    createAccessGrant: (...args: unknown[]) => createAccessGrant(...args),
    revokeAccessGrant: (...args: unknown[]) => revokeAccessGrant(...args),
  },
}));
vi.mock("@/api/access", () => ({
  accessApi: { listUserDirectory: (...args: unknown[]) => listUserDirectory(...args) },
}));
vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

import { IssueShareSheet } from "./IssueShareSheet";
import { queryKeys } from "@/lib/queryKeys";

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
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollIntoView = () => {};
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    listAccessGrants.mockReset();
    createAccessGrant.mockReset();
    revokeAccessGrant.mockReset();
    listUserDirectory.mockReset().mockResolvedValue({ users: [] });
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  async function renderSheet(canManage = true, implicitPrincipals: import("./IssueShareSheet").ShareSheetImplicitPrincipal[] = []) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.issues.accessGrants("descendant"), []);
    root = createRoot(container);
    act(() => {
      root!.render(
        <QueryClientProvider client={client}>
          <IssueShareSheet
            implicitPrincipals={implicitPrincipals}
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
    return client;
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

  it("removes a saved grant while explaining that assignment access remains", async () => {
    listAccessGrants.mockResolvedValue([grant({ id: "g1", source: "assignment", subjectType: "agent", subjectId: "a1" })]);
    const client = await renderSheet(true, [{ id: "agent:a1", displayName: "Helper", roleLabel: "Current assignee" }]);
    expect([...document.body.querySelectorAll("button")].filter(button => button.textContent?.trim() === "Revoke")).toHaveLength(0);
    expect(document.body.textContent).toContain("access remains while this role applies");
    const removeSaved = [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim() === "Remove saved grant");
    expect(removeSaved).toBeDefined();
    act(() => removeSaved!.click());
    await settle();
    expect(document.body.textContent).toContain("saved grant?");
    revokeAccessGrant.mockResolvedValue({});
    const confirm = [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim() === "Remove grant");
    act(() => confirm!.click());
    await settle();
    expect(revokeAccessGrant).toHaveBeenCalledWith("i1", "g1");
    expect(client.getQueryState(queryKeys.issues.accessGrants("descendant"))?.isInvalidated).toBe(true);
  });

  it.each([
    { source: "project" as const, inherited: true },
    { source: "explicit" as const, inherited: true },
  ])("allows an independent direct grant alongside $source access", async (access) => {
    listAccessGrants.mockResolvedValue([grant({ id: "broader", ...access })]);
    listUserDirectory.mockResolvedValue({ users: [{ user: { id: "u1", name: "Ada", email: "ada@example.test", image: null } }] });
    createAccessGrant.mockResolvedValue(grant({ id: "direct" }));
    const client = await renderSheet();
    act(() => [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim() === "Add someone")!.click());
    await settle();
    act(() => (document.body.querySelector('[role="combobox"]') as HTMLElement).click());
    await settle();
    const option = [...document.body.querySelectorAll('[role="option"]')].find(option => option.textContent?.includes("Ada"));
    expect(option).toBeDefined();
    act(() => (option as HTMLElement).click());
    await settle();
    act(() => [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim() === "Add")!.click());
    await settle();
    expect(createAccessGrant).toHaveBeenCalledWith("i1", { subjectType: "user", subjectId: "u1" });
    expect(client.getQueryState(queryKeys.issues.accessGrants("descendant"))?.isInvalidated).toBe(true);
  });

  it("does not offer a second grant for an existing direct assignment grant", async () => {
    listAccessGrants.mockResolvedValue([grant({ source: "assignment" })]);
    listUserDirectory.mockResolvedValue({ users: [{ user: { id: "u1", name: "Ada", image: null } }] });
    await renderSheet();
    act(() => [...document.body.querySelectorAll("button")].find(button => button.textContent?.trim() === "Add someone")!.click());
    await settle();
    act(() => (document.body.querySelector('[role="combobox"]') as HTMLElement).click());
    await settle();
    expect([...document.body.querySelectorAll('[role="option"]')].some(option => option.textContent?.includes("Ada"))).toBe(false);
    expect(createAccessGrant).not.toHaveBeenCalled();
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
