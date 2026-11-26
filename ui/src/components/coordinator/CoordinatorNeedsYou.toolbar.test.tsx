// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { CoordinatorNeedsYou } from "./CoordinatorNeedsYou";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({
  byView: {} as Record<string, AttentionItem[]>,
  listCalls: [] as Array<{ view?: string }>,
  agents: [] as Agent[] | null,
  agentsGate: null as null | Promise<void>,
  boardAccess: null as null | Record<string, unknown>,
  boardAccessGate: null as null | Promise<void>,
  navigate: vi.fn(), breadcrumbs: vi.fn(), openPanel: vi.fn(), closePanel: vi.fn(), setPanelVisible: vi.fn(),
}));
vi.mock("@/api/inboxDismissals", () => ({ inboxDismissalsApi: { restore: vi.fn(async () => ({})), dismiss: vi.fn(async () => ({})) } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: fixture.breadcrumbs }) }));
vi.mock("@/context/PanelContext", () => ({ usePanel: () => ({ openPanel: fixture.openPanel, closePanel: fixture.closePanel, setPanelVisible: fixture.setPanelVisible, panelVisible: true }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ userId: "reviewer" }) }));
vi.mock("@/lib/router", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/router")>(), useNavigate: () => fixture.navigate }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => {
  if (fixture.agentsGate) await fixture.agentsGate;
  if (!fixture.agents) throw new Error("Agents unavailable");
  return fixture.agents;
} } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/access", () => ({ accessApi: {
  listUserDirectory: async () => ({ users: [{ principalId: "dotta", status: "active", user: { name: "Dotta" } }] }),
  getCurrentBoardAccess: async () => {
    if (fixture.boardAccessGate) await fixture.boardAccessGate;
    if (!fixture.boardAccess) throw new Error("No board access");
    return fixture.boardAccess;
  },
} }));
vi.mock("@/api/attention", () => ({ attentionApi: {
  claim: vi.fn(async () => ({})),
  close: vi.fn(async () => ({ until: null })),
  list: async (_companyId: string, options: { view?: string }) => {
    fixture.listCalls.push(options);
    return { items: [...(fixture.byView[options.view ?? ""] ?? [])], viewCounts: { mine: 0, unassigned: 0, company: 0, archived: 0, all: 0 }, receipts: [] };
  },
  history: async () => ({ items: [], nextCursor: null }),
  runHistory: async () => ({ items: [], nextCursor: null }),
} }));
vi.mock("motion/react", () => ({
  LayoutGroup: ({ children }: { children: ReactNode }) => children,
  useReducedMotion: () => true,
  motion: { div: ({ children, id, tabIndex }: { children: ReactNode; id?: string; tabIndex?: number }) => <div id={id} tabIndex={tabIndex}>{children}</div> },
}));
vi.mock("@/components/PropertiesPanel", () => ({ PROPERTIES_PANE_HEADER_SLOT_ID: "test-sidebar" }));
vi.mock("@/components/DecisionResolver", () => ({ DecisionResolver: () => null }));
vi.mock("@/components/AttentionInteractionResolver", () => ({ AttentionInteractionResolver: ({ interactionId }: { interactionId: string }) => <span>{interactionId}</span> }));

function Location() { return <output data-location>{useLocation().search}</output>; }

const member = (membershipRole: string) => ({ userId: "reviewer", source: "session", isInstanceAdmin: false, companyIds: ["company"],
  memberships: [{ companyId: "company", membershipRole, status: "active" }] });
const card = (id: string, minutesAgo: number, extra: { userId?: string; agentId?: string; project?: { id: string; name: string } } = {}) => ({
  id, sourceKind: "issue_thread_interaction", inlineResolvable: true,
  subject: { id, kind: "interaction", title: `Card ${id}`, metadata: { issueId: `task-${id}`, ...(extra.agentId ? { createdByAgentId: extra.agentId } : {}) } },
  relatedIssue: { id: `task-${id}`, identifier: `PAP-${id}`, title: `Task ${id}`, href: `/PAP/issues/PAP-${id}` },
  project: extra.project ?? null, originAgentName: null, activityAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  audience: { kind: "user", userId: extra.userId ?? "reviewer", reason: "addressee" },
}) as unknown as AttentionItem;
const website = { id: "project-web", name: "Website" };

let root: Root;
let container: HTMLDivElement;
let client: QueryClient | null = null;
beforeEach(() => {
  fixture.byView = {}; fixture.listCalls = []; fixture.boardAccess = null; fixture.boardAccessGate = null; fixture.agentsGate = null;
  fixture.agents = [{ id: "agent-cos", name: "Chief of Staff" }] as Agent[];
  localStorage.clear();
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client?.clear(); client = null; container.remove(); vi.restoreAllMocks(); });
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function visit(url: string) {
  if (client) {
    await act(async () => root.unmount());
    client.clear();
    root = createRoot(container);
  }
  fixture.listCalls = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client!}><MemoryRouter initialEntries={[url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
  await flush(); await flush();
}
const filterButton = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`)!;
const assignee = () => filterButton("Filter decisions by assignee");
async function menuItems(trigger: HTMLButtonElement) {
  if (trigger.getAttribute("aria-expanded") !== "true") {
    await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); });
    await flush();
  }
  return [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
}
async function choose(label: string, optionLabel: string) {
  const trigger = filterButton(label);
  const item = (await menuItems(trigger)).find((option) => option.textContent === optionLabel);
  expect(item, `${label} -> ${optionLabel}`).toBeDefined();
  await act(async () => item!.click());
  await flush();
}
const cards = () => [...container.querySelectorAll("[data-attention-card]")].map((node) => node.getAttribute("data-attention-card"));
const location = () => container.querySelector("[data-location]")?.textContent;
const listedViews = () => fixture.listCalls.map((call) => call.view);

describe("Needs You keeps its toolbar between visits", () => {
  it("opens All assignees for a board member, and keeps the chosen assignee, agent, project and grouping on the next visit", async () => {
    fixture.boardAccess = member("admin");
    const ours = card("ours", 1, { agentId: "agent-cos", project: website });
    fixture.byView = { all: [ours, card("dottas", 2, { userId: "dotta" })], mine: [ours] };
    await visit("/decisions");
    await vi.waitFor(() => expect(assignee().value).toBe("all"));
    expect(assignee().textContent).toBe("All assignees");
    expect(assignee().getAttribute("aria-label")).toBe("Filter decisions by assignee, All assignees");
    expect(location()).toBe("");
    expect(listedViews()).toEqual(["all"]);
    expect(cards()).toEqual(["ours", "dottas"]);

    await choose("Filter decisions by agent", "Chief of Staff");
    await choose("Filter decisions by project", "Website");
    await choose("Group decisions", "By project");
    await choose("Filter decisions by assignee", "Assigned to you");
    expect(location()).toBe("?view=mine");
    expect(cards()).toEqual(["ours"]);

    await visit("/decisions");
    await vi.waitFor(() => expect(cards()).toEqual(["ours"]));
    expect(assignee().value).toBe("me");
    expect(filterButton("Filter decisions by agent").value).toBe("agent-cos");
    expect(filterButton("Filter decisions by project").value).toBe("project-web");
    expect(filterButton("Group decisions").value).toBe("project");
    expect([...container.querySelectorAll("h2")].map((heading) => heading.textContent)).toContain("Website");
    expect(location()).toBe("");
    expect(listedViews()).toEqual(["mine"]);
  });

  it("reopens one person's cards, and a link's own view wins without replacing the kept choice", async () => {
    fixture.boardAccess = member("admin");
    fixture.byView = { all: [card("ours", 1), card("dottas", 2, { userId: "dotta" })], company: [card("alert", 3, { userId: "dotta" })] };
    await visit("/decisions");
    await vi.waitFor(() => expect(assignee().value).toBe("all"));
    await choose("Filter decisions by assignee", "Dotta");
    expect(location()).toBe("?view=all&for=dotta");
    expect(cards()).toEqual(["dottas"]);

    await visit("/decisions");
    await vi.waitFor(() => expect(cards()).toEqual(["dottas"]));
    expect(assignee().value).toBe("user:dotta");
    expect(assignee().textContent).toBe("Dotta");

    await visit("/decisions?view=company");
    await vi.waitFor(() => expect(cards()).toEqual(["alert"]));
    expect(assignee().value).toBe("company");

    await visit("/decisions");
    await vi.waitFor(() => expect(cards()).toEqual(["dottas"]));
    expect(assignee().value).toBe("user:dotta");
  });

  it("opens Assigned to you for a viewer, even when another person's cards were kept on this browser", async () => {
    fixture.boardAccess = member("admin");
    fixture.byView = { all: [card("ours", 1), card("dottas", 2, { userId: "dotta" })], mine: [card("ours", 1)] };
    await visit("/decisions");
    await vi.waitFor(() => expect(assignee().value).toBe("all"));
    await choose("Filter decisions by assignee", "Dotta");

    fixture.boardAccess = member("viewer");
    await visit("/decisions");
    await vi.waitFor(() => expect(cards()).toEqual(["ours"]));
    expect(assignee().value).toBe("me");
    expect((await menuItems(assignee())).map((option) => option.textContent)).toEqual(["Assigned to you", "No owner yet", "Company alerts"]);
    expect(listedViews()).toEqual(["mine"]);
  });

  it("opens Assigned to you when board access cannot be read", async () => {
    fixture.byView = { all: [card("ours", 1), card("dottas", 2, { userId: "dotta" })], mine: [card("ours", 1)] };
    await visit("/decisions");
    await vi.waitFor(() => expect(cards()).toEqual(["ours"]));
    expect(assignee().value).toBe("me");
    expect(assignee().disabled).toBe(false);
    expect(listedViews()).toEqual(["mine"]);
  });

  it("reads no feed until board access is known, so Assigned to you never shows first", async () => {
    let release!: () => void;
    fixture.boardAccessGate = new Promise<void>((resolve) => { release = resolve; });
    fixture.boardAccess = member("admin");
    fixture.byView = { all: [card("ours", 1), card("dottas", 2, { userId: "dotta" })], mine: [card("ours", 1)] };
    await visit("/decisions");
    expect(listedViews()).toEqual([]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading decisions");
    expect(cards()).toEqual([]);
    expect(container.querySelector("[data-needs-you-summary]")).toBeNull();
    expect(assignee().value).toBe("all");
    expect(assignee().disabled).toBe(true);

    await act(async () => release()); await flush(); await flush();
    await vi.waitFor(() => expect(cards()).toEqual(["ours", "dottas"]));
    expect(assignee().value).toBe("all");
    expect(assignee().disabled).toBe(false);
    expect(listedViews()).toEqual(["all"]);
  });

  it("still names a kept project with no open cards, so the filter never reads as All projects", async () => {
    fixture.boardAccess = member("admin");
    fixture.byView = { all: [card("ours", 1, { project: website }), card("other", 2)] };
    await visit("/decisions");
    await vi.waitFor(() => expect(cards()).toEqual(["ours", "other"]));
    await choose("Filter decisions by project", "Website");
    expect(cards()).toEqual(["ours"]);

    fixture.byView = { all: [card("other", 2)] };
    await visit("/decisions");
    await vi.waitFor(() => expect(container.textContent).toContain("No open decisions match these filters."));
    expect(filterButton("Filter decisions by project").value).toBe("project-web");
    expect(filterButton("Filter decisions by project").textContent).toBe("Website");
    await choose("Filter decisions by project", "All projects");
    expect(cards()).toEqual(["other"]);
  });

  it("stops filtering by a kept agent the company no longer has", async () => {
    fixture.agents = [{ id: "agent-cos", name: "Chief of Staff" }, { id: "agent-old", name: "Old agent" }] as Agent[];
    fixture.boardAccess = member("admin");
    fixture.byView = { all: [card("ours", 1, { agentId: "agent-old" }), card("other", 2)] };
    await visit("/decisions");
    await vi.waitFor(() => expect(cards()).toEqual(["ours", "other"]));
    await choose("Filter decisions by agent", "Old agent");
    expect(cards()).toEqual(["ours"]);

    fixture.agents = [{ id: "agent-cos", name: "Chief of Staff" }] as Agent[];
    await visit("/decisions");
    await vi.waitFor(() => expect(cards()).toEqual(["ours", "other"]));
    expect(filterButton("Filter decisions by agent").value).toBe("");
  });

  it("shows every agent's cards while the agent list cannot be read, then filters by the kept agent again", async () => {
    fixture.boardAccess = member("admin");
    fixture.byView = { all: [card("ours", 1, { agentId: "agent-cos" }), card("other", 2)] };
    await visit("/decisions");
    await vi.waitFor(() => expect(cards()).toEqual(["ours", "other"]));
    await choose("Filter decisions by agent", "Chief of Staff");
    expect(cards()).toEqual(["ours"]);

    fixture.agents = null;
    await visit("/decisions");
    await vi.waitFor(() => expect(cards()).toEqual(["ours", "other"]));
    expect(filterButton("Filter decisions by agent").value).toBe("");
    expect(filterButton("Filter decisions by agent").getAttribute("aria-label")).toBe("Filter decisions by agent, All agents");

    fixture.agents = [{ id: "agent-cos", name: "Chief of Staff" }] as Agent[];
    await visit("/decisions");
    await vi.waitFor(() => expect(cards()).toEqual(["ours"]));
    expect(filterButton("Filter decisions by agent").value).toBe("agent-cos");
  });

  it("lets a decision link clear kept filters for that visit only", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, writable: true, value: vi.fn() });
    fixture.boardAccess = member("admin");
    const linked = { ...card("linked", 3), sourceKind: "decision", subject: { id: "target", kind: "decision", title: "Linked decision" } } as unknown as AttentionItem;
    fixture.byView = { all: [card("ours", 1, { agentId: "agent-cos", project: website }), linked] };
    await visit("/decisions");
    await vi.waitFor(() => expect(cards()).toEqual(["ours", "linked"]));
    await choose("Filter decisions by agent", "Chief of Staff");
    await choose("Filter decisions by project", "Website");
    expect(cards()).toEqual(["ours"]);

    await visit("/decisions?decisionId=target");
    for (let tick = 0; tick < 5; tick++) await flush();
    expect(container.querySelector("#coordinator-decision-target")).not.toBeNull();
    expect(filterButton("Filter decisions by agent").value).toBe("");
    expect(filterButton("Filter decisions by project").value).toBe("");
    expect(location()).not.toContain("decisionId");
    await choose("Group decisions", "By task");

    await visit("/decisions");
    await vi.waitFor(() => expect(cards()).toEqual(["ours"]));
    expect(filterButton("Filter decisions by agent").value).toBe("agent-cos");
    expect(filterButton("Filter decisions by project").value).toBe("project-web");
    expect(filterButton("Group decisions").value).toBe("task");
  });

  it("keeps a decision link's card in view when the agent list loads after it", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, writable: true, value: vi.fn() });
    fixture.boardAccess = member("admin");
    const linked = { ...card("linked", 3), sourceKind: "decision", subject: { id: "target", kind: "decision", title: "Linked decision" } } as unknown as AttentionItem;
    fixture.byView = { all: [card("ours", 1, { agentId: "agent-cos" }), linked] };
    await visit("/decisions");
    await vi.waitFor(() => expect(cards()).toEqual(["ours", "linked"]));
    await choose("Filter decisions by agent", "Chief of Staff");
    expect(cards()).toEqual(["ours"]);

    let release!: () => void;
    fixture.agentsGate = new Promise<void>((resolve) => { release = resolve; });
    await visit("/decisions?decisionId=target");
    for (let tick = 0; tick < 5; tick++) await flush();
    expect(location()).not.toContain("decisionId");
    await act(async () => release()); await flush(); await flush();
    expect(cards()).toEqual(["ours", "linked"]);
    expect(filterButton("Filter decisions by agent").value).toBe("");
  });

  it("returns from Archived to the kept assignee", async () => {
    fixture.boardAccess = member("admin");
    fixture.byView = { all: [card("ours", 1), card("dottas", 2, { userId: "dotta" })], unassigned: [card("pool", 4)], archived: [] };
    await visit("/decisions");
    await vi.waitFor(() => expect(assignee().value).toBe("all"));
    await choose("Filter decisions by assignee", "No owner yet");
    await vi.waitFor(() => expect(cards()).toEqual(["pool"]));

    await visit("/decisions?view=archived");
    await vi.waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Archived"));
    await act(async () => container.querySelector<HTMLElement>('[aria-label="Back to Needs You"]')!.click()); await flush();
    expect(location()).toBe("");
    await vi.waitFor(() => expect(cards()).toEqual(["pool"]));
    expect(assignee().value).toBe("unassigned");
  });

  it("keeps saved filters when switching to Waiting and back to Needs you, and loads Waiting without waiting for board access", async () => {
    fixture.boardAccess = member("admin");
    const dottas = card("dottas", 1, { userId: "dotta", agentId: "agent-cos", project: website });
    const other = card("other", 2);
    const waiting = card("waiting-1", 3);
    fixture.byView = { all: [dottas, other], waiting: [waiting] };
    await visit("/decisions");
    await vi.waitFor(() => expect(assignee().value).toBe("all"));
    await choose("Filter decisions by agent", "Chief of Staff");
    await choose("Filter decisions by project", "Website");
    await choose("Filter decisions by assignee", "Dotta");
    await vi.waitFor(() => expect(cards()).toEqual(["dottas"]));

    const waitingTab = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Inbox views"] button')].find((button) => button.textContent?.startsWith("Waiting"))!;
    await act(async () => waitingTab.click()); await flush();
    await vi.waitFor(() => expect(cards()).toEqual(["waiting-1"]));

    const needsTab = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Inbox views"] button')].find((button) => button.textContent === "Needs you")!;
    await act(async () => needsTab.click()); await flush();
    await vi.waitFor(() => expect(cards()).toEqual(["dottas"]));
    expect(assignee().value).toBe("user:dotta");
    expect(filterButton("Filter decisions by agent").value).toBe("agent-cos");
    expect(filterButton("Filter decisions by project").value).toBe("project-web");

    // Visiting ?folder=waiting directly loads waiting feed immediately even while boardAccess is pending,
    // without applying Needs You's saved person/agent/project filters, and keeps a Waiting filter chosen
    // before boardAccess settles.
    let releaseBoardAccess!: () => void;
    fixture.boardAccessGate = new Promise<void>((resolve) => { releaseBoardAccess = resolve; });
    const waitingAgent = card("waiting-agent", 2, { agentId: "agent-cos" });
    fixture.byView = { ...fixture.byView, waiting: [waitingAgent, waiting] };
    await visit("/decisions?folder=waiting");
    await vi.waitFor(() => expect(cards()).toEqual(["waiting-agent", "waiting-1"]));
    expect(listedViews()).toEqual(["waiting"]);

    await choose("Filter decisions by agent", "Chief of Staff");
    expect(cards()).toEqual(["waiting-agent"]);

    await act(async () => releaseBoardAccess()); await flush(); await flush();
    expect(filterButton("Filter decisions by agent").value).toBe("agent-cos");
    expect(cards()).toEqual(["waiting-agent"]);
  });
});
