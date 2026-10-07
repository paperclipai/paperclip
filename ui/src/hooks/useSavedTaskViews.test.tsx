// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedTaskView } from "@paperclipai/shared";
import { useSavedTaskViews, type UseSavedTaskViewsResult } from "./useSavedTaskViews";
import { STARTER_SAVED_TASK_VIEWS } from "@/lib/saved-task-views";

const savedTaskViewsApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
const authApi = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/api/savedTaskViews", () => ({ savedTaskViewsApi }));
vi.mock("@/api/auth", () => ({ authApi }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COLLECTION = "paperclip:issues-view";

function view(id: string, name: string): SavedTaskView {
  return {
    id,
    name,
    viewState: {},
    companyId: "company-1",
    userId: "user-1",
    collectionKey: COLLECTION,
    position: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as SavedTaskView;
}

let container: HTMLDivElement;
let root: Root;
let latest: UseSavedTaskViewsResult;

function Probe() {
  latest = useSavedTaskViews("company-1", COLLECTION);
  return null;
}

async function mount(client: QueryClient) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
}

/** Lets the session query, then the list query it gates, settle and render. */
async function settle(check: () => boolean = () => !latest.isResolving) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    if (check()) return;
  }
  throw new Error("queries did not settle");
}

describe("useSavedTaskViews", () => {
  beforeEach(() => {
    savedTaskViewsApi.list.mockReset();
    savedTaskViewsApi.create.mockReset();
    authApi.getSession.mockReset();
    savedTaskViewsApi.create.mockImplementation(
      (_companyId: string, input: { name: string }) =>
        Promise.resolve(view(`created-${input.name}`, input.name)),
    );
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("does not serve one user's views to the next user in the same company", async () => {
    // One page, one company, two sessions. A session can end without a reload,
    // and view names — and the search text inside a definition — are private.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    authApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    savedTaskViewsApi.list.mockResolvedValue([view("v1", "Unpaid invoices")]);

    await mount(client);
    await settle(() => latest.views.length > 0);
    expect(latest.views.map((entry) => entry.name)).toEqual(["Unpaid invoices"]);

    // The next person signs in. Only the session is refetched.
    authApi.getSession.mockResolvedValue({ user: { id: "user-2" } });
    savedTaskViewsApi.list.mockResolvedValue([]);
    await act(async () => { await client.refetchQueries({ queryKey: ["auth"] }); });
    await settle(() => latest.views.length === 0 && !latest.isResolving);

    expect(latest.views).toEqual([]);
  });

  it("holds off until the session is known, so a saved view link is not given up on", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveSession: (value: unknown) => void = () => {};
    authApi.getSession.mockReturnValue(new Promise((resolve) => { resolveSession = resolve; }));
    savedTaskViewsApi.list.mockResolvedValue([]);

    await mount(client);
    expect(latest.isResolving).toBe(true);
    expect(savedTaskViewsApi.list).not.toHaveBeenCalled();

    await act(async () => { resolveSession({ user: { id: "user-1" } }); });
    await settle(() => savedTaskViewsApi.list.mock.calls.length > 0);
    expect(savedTaskViewsApi.list).toHaveBeenCalled();
  });

  it("creates only the starter views that are missing", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    authApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    savedTaskViewsApi.list.mockResolvedValue(
      STARTER_SAVED_TASK_VIEWS.slice(0, 3).map((starter, index) => view(`v${index}`, starter.name)),
    );

    await mount(client);
    await settle(() => latest.views.length === 3);

    await act(async () => { await latest.addStarterViews.mutateAsync(); });

    expect(savedTaskViewsApi.create.mock.calls.map(([, input]) => input.name)).toEqual(
      STARTER_SAVED_TASK_VIEWS.slice(3).map((starter) => starter.name),
    );
  });
});
