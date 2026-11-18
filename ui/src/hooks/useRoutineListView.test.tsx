// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { defaultRoutineView, routineViewStorageKey } from "@/lib/routine-list-view";
import { useRoutineListView } from "./useRoutineListView";
import { authApi } from "@/api/auth";

vi.mock("@/lib/router", async () => {
  const router = await import("react-router-dom");
  return { useSearchParams: router.useSearchParams };
});
vi.mock("@/api/auth", () => ({ authApi: { getSession: vi.fn() } }));

let current: ReturnType<typeof useRoutineListView>;
let search = "";
let navigate: ReturnType<typeof useNavigate>;
function Harness({ companyId }: { companyId: string }) {
  current = useRoutineListView(companyId);
  search = useLocation().search;
  navigate = useNavigate();
  return <output>{JSON.stringify(current[0])}</output>;
}

describe("routine view persistence", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "u1" } });
  });
  afterEach(async () => {
    await act(() => root.unmount());
    client.clear();
    container.remove();
    vi.restoreAllMocks();
  });
  async function render(companyId = "c1", entry = "/routines") {
    await act(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[entry]}><Harness companyId={companyId} /></MemoryRouter></QueryClientProvider>));
  }

  it("restores changed filters and columns after a remount and isolates other people and companies", async () => {
    await render();
    await act(() => current[1]({ projects: ["p1"], query: "weekly", groupBy: "none", sortField: "created", sortDir: "desc" }));
    await act(() => current[1]({ columns: ["assignee", "responsibleUser"], collapsedGroups: ["g1"] }));
    expect(new URLSearchParams(search).get("projects")).toBe("p1");
    expect(new URLSearchParams(search).get("q")).toBe("weekly");
    expect(JSON.parse(localStorage.getItem(routineViewStorageKey("c1", "u1"))!)).toEqual(current[0]);
    await act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(current[0]).toMatchObject({ projects: ["p1"], query: "weekly", columns: ["assignee", "responsibleUser"], collapsedGroups: ["g1"], sortField: "created", sortDir: "desc", groupBy: "none" });
    await render("c2");
    expect(current[0]).toEqual(defaultRoutineView);
    await act(() => client.setQueryData(queryKeys.auth.session, { user: { id: "u2" } }));
    await render();
    expect(current[0]).toEqual(defaultRoutineView);
  });

  it("lets shared and cleared URLs override saved filters during navigation", async () => {
    localStorage.setItem(routineViewStorageKey("c1", "u1"), JSON.stringify({ ...defaultRoutineView, projects: ["saved"], statuses: ["paused"] }));
    await render("c1", "/routines?projects=shared");
    expect(current[0].projects).toEqual(["shared"]);
    expect(current[0].statuses).toEqual([]);
    await act(() => navigate("/routines?filters=1"));
    expect(current[0].projects).toEqual([]);
    await act(() => navigate(-1));
    expect(current[0].projects).toEqual(["shared"]);
  });

  it("keeps controls usable when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    await render();
    await act(() => current[1]({ columns: ["assignee"], agents: ["a1"] }));
    expect(current[0].columns).toEqual(["assignee"]);
    expect(current[0].agents).toEqual(["a1"]);
    expect(new URLSearchParams(search).get("agents")).toBe("a1");
  });

  it("restores and saves local-trusted preferences without an account", async () => {
    client.setQueryData(queryKeys.auth.session, null);
    client.setQueryData(queryKeys.health, { deploymentMode: "local_trusted" });
    localStorage.setItem("paperclip:routines-view:c1", JSON.stringify({ groupBy: "none", sortField: "created" }));
    await render();
    expect(current[0].groupBy).toBe("none");
    await act(() => current[1]({ columns: ["assignee"], collapsedGroups: ["g1"] }));
    expect(JSON.parse(localStorage.getItem(routineViewStorageKey("c1", "local-board"))!)).toMatchObject({ columns: ["assignee"], collapsedGroups: ["g1"] });
    await act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(current[0].columns).toEqual(["assignee"]);
  });

  it("retains controls changed while the session is loading", async () => {
    client.removeQueries({ queryKey: queryKeys.auth.session });
    let resolveSession!: (value: Awaited<ReturnType<typeof authApi.getSession>>) => void;
    vi.mocked(authApi.getSession).mockReturnValue(new Promise(resolve => { resolveSession = resolve; }));
    localStorage.setItem(routineViewStorageKey("c1", "u1"), JSON.stringify({ ...defaultRoutineView, columns: ["project"], groupBy: "none" }));
    await render();
    await act(() => current[1]({ columns: ["assignee"], collapsedGroups: ["g1"] }));
    await act(async () => { resolveSession({ user: { id: "u1" } } as Awaited<ReturnType<typeof authApi.getSession>>); });
    await vi.waitFor(() => expect(client.getQueryData(queryKeys.auth.session)).toMatchObject({ user: { id: "u1" } }));
    await vi.waitFor(() => expect(current[0].groupBy).toBe("none"));
    expect(current[0].columns).toEqual(["assignee"]);
    expect(JSON.parse(localStorage.getItem(routineViewStorageKey("c1", "u1"))!)).toMatchObject({ columns: ["assignee"], collapsedGroups: ["g1"] });
  });

  it("does not use local-board preferences for an unsigned authenticated deployment", async () => {
    client.setQueryData(queryKeys.auth.session, null);
    client.setQueryData(queryKeys.health, { deploymentMode: "authenticated" });
    await render();
    await act(() => current[1]({ columns: ["assignee"] }));
    expect(localStorage.getItem(routineViewStorageKey("c1", "local-board"))).toBeNull();
  });

  it("keeps personal filters when changing columns on a shared link", async () => {
    localStorage.setItem(routineViewStorageKey("c1", "u1"), JSON.stringify({ ...defaultRoutineView, projects: ["personal"], groupBy: "none" }));
    await render("c1", "/routines?projects=shared");
    await act(() => current[1]({ columns: ["assignee"] }));
    expect(current[0].projects).toEqual(["shared"]);
    expect(JSON.parse(localStorage.getItem(routineViewStorageKey("c1", "u1"))!)).toMatchObject({ projects: ["personal"], columns: ["assignee"] });
    await act(() => current[1]({ statuses: ["paused"] }));
    await act(() => current[1]({ collapsedGroups: ["g1"] }));
    expect(JSON.parse(localStorage.getItem(routineViewStorageKey("c1", "u1"))!)).toMatchObject({ projects: ["shared"], statuses: ["paused"], collapsedGroups: ["g1"] });
  });

  it("restores personal filters after leaving a shared link with changed columns", async () => {
    localStorage.setItem(routineViewStorageKey("c1", "u1"), JSON.stringify({ ...defaultRoutineView, projects: ["personal"], statuses: ["paused"] }));
    await render("c1", "/routines?projects=shared");
    await act(() => current[1]({ columns: ["assignee"], collapsedGroups: ["g1"] }));
    await act(() => navigate("/routines"));
    expect(current[0]).toMatchObject({ projects: ["personal"], statuses: ["paused"], columns: ["assignee"], collapsedGroups: ["g1"] });
    await act(() => navigate(-1));
    expect(current[0].projects).toEqual(["shared"]);
  });
});
