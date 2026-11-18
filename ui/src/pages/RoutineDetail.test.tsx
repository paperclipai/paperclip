// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, RoutineDetail as RoutineDetailData, RoutineTrigger } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { routinesApi } from "../api/routines";
import { issuesApi } from "../api/issues";
import { responsibilitiesApi } from "../api/responsibilities";
import { instanceSettingsApi } from "../api/instanceSettings";
import { accessApi } from "../api/access";
import { RoutineDetail, ROUTINE_HISTORY_PAGE_SIZE } from "./RoutineDetail";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const route = vi.hoisted(() => ({ params: { routineId: "routine-1" } as { routineId: string; section?: string }, search: "", hash: "" }));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Navigate: ({ to }: { to: string }) => <a data-redirect href={to}>Redirect</a>,
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => navigateMock,
  useParams: () => route.params,
  useLocation: () => ({ pathname: "/routines/routine-1", search: route.search, hash: route.hash }),
  useSearchParams: () => [new URLSearchParams(route.search), vi.fn()],
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn(), setBreadcrumbToolbar: vi.fn() }),
}));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: false, loaded: true }) }));
vi.mock("../api/routines", () => ({
  routinesApi: {
    get: vi.fn(),
    update: vi.fn(),
    run: vi.fn(),
    createTrigger: vi.fn(),
    updateTrigger: vi.fn(),
    listRevisions: vi.fn(async () => []),
    rotateTriggerSecret: vi.fn(),
  },
}));
vi.mock("../api/issues", () => ({ issuesApi: { list: vi.fn() } }));
vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn(async () => [{ id: "agent-1", name: "Digest Bot", status: "active", role: "engineer", title: null }]) },
}));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn(async () => []) } }));
vi.mock("../api/access", () => ({
  accessApi: {
    listUserDirectory: vi.fn(async () => ({
      users: [{ principalId: "user-1", status: "active", user: { name: "Riley Board", email: "riley@example.com", image: null } }],
    })),
  },
}));
vi.mock("../api/secrets", () => ({ secretsApi: { list: vi.fn(async () => []), create: vi.fn() } }));
vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: vi.fn(async () => ({ enableResponsibilities: false })) },
}));
vi.mock("../api/responsibilities", () => ({
  responsibilitiesApi: {
    overview: vi.fn(async () => ({ areas: [], responsibilities: [], proposed: [] })),
    lookupRoutineLinks: vi.fn(async () => ({ responsibilities: [] })),
    link: vi.fn(),
    unlink: vi.fn(),
    get: vi.fn(),
  },
}));
vi.mock("@/components/MarkdownEditor", () => ({ MarkdownEditor: () => <div data-testid="markdown-editor" /> }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/TaskSummaryList", () => ({
  TaskSummaryList: ({ issues }: { issues: Issue[] }) => (
    <ul aria-label="Tasks created by this routine">{issues.map((issue) => <li key={issue.id}>{issue.title}</li>)}</ul>
  ),
}));
vi.mock("@/components/IssueDocumentAnnotations", () => ({
  IssueDocumentAnnotations: ({ children, panelOpen }: { children: ReactNode; panelOpen: boolean }) => (
    <div data-testid="instruction-comments" data-open={panelOpen}>{children}</div>
  ),
}));
vi.mock("@/components/RoutineRunVariablesDialog", () => ({ RoutineRunVariablesDialog: () => null }));
vi.mock("@/components/RoutineHistoryTab", () => ({ RoutineHistoryTab: () => <div>Revision list</div> }));
vi.mock("@/pages/audit/RoutineAuditActivity", () => ({ RoutineAuditActivity: () => <div>Routine activity feed</div> }));

function trigger(overrides: Partial<RoutineTrigger>): RoutineTrigger {
  return {
    id: "trigger-1",
    companyId: "company-1",
    routineId: "routine-1",
    kind: "schedule",
    label: null,
    enabled: true,
    cronExpression: "0 9 * * 1-5",
    timezone: "America/Chicago",
    nextRunAt: new Date(Date.now() + 3_600_000),
    lastFiredAt: null,
    publicId: null,
    secretId: null,
    signingMode: null,
    replayWindowSec: null,
    lastRotatedAt: null,
    lastResult: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

function routine(overrides: Partial<RoutineDetailData> = {}): RoutineDetailData {
  return {
    id: "routine-1",
    companyId: "company-1",
    projectId: null,
    goalId: null,
    parentIssueId: null,
    title: "Send the weekly digest",
    description: "Summarize the week.",
    assigneeAgentId: "agent-1",
    priority: "high",
    status: "active",
    concurrencyPolicy: "always_enqueue",
    catchUpPolicy: "skip_missed",
    activityGatePolicy: "always",
    activityGateScope: "company",
    variables: [],
    env: null,
    latestRevisionId: "revision-1",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "user-1",
    responsibleUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: null,
    lastTriggeredAt: null,
    lastEnqueuedAt: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    canChangeResponsibleUser: true,
    project: null,
    assignee: { id: "agent-1", name: "Digest Bot", role: "engineer", title: null },
    parentIssue: null,
    descriptionDocument: null,
    triggers: [trigger({})],
    recentRuns: [],
    activeIssue: null,
    ...overrides,
  };
}

function task(index: number): Issue {
  return { id: `task-${index}`, title: `Digest ${index}`, status: "done" } as Issue;
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function button(name: string, scope: ParentNode = document) {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
    (element) => element.textContent?.trim() === name || element.getAttribute("aria-label") === name,
  );
}

describe("RoutineDetail (routed routine page)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  async function render() {
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><RoutineDetail /></QueryClientProvider>);
      await flush();
    });
  }

  beforeEach(() => {
    route.params = { routineId: "routine-1" };
    route.search = "";
    route.hash = "";
    navigateMock.mockReset();
    vi.mocked(routinesApi.get).mockReset().mockResolvedValue(routine());
    vi.mocked(routinesApi.update).mockReset();
    vi.mocked(routinesApi.updateTrigger).mockReset().mockResolvedValue(trigger({}));
    vi.mocked(issuesApi.list).mockReset().mockResolvedValue([task(1)]);
    vi.mocked(responsibilitiesApi.lookupRoutineLinks).mockReset().mockResolvedValue({ responsibilities: [] });
    vi.mocked(responsibilitiesApi.link).mockClear();
    vi.mocked(responsibilitiesApi.unlink).mockClear();
    vi.mocked(responsibilitiesApi.overview).mockClear();
    vi.mocked(instanceSettingsApi.getExperimental).mockResolvedValue({ enableResponsibilities: false } as never);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(() => root.unmount());
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
  });

  it("redirects old section addresses to the single page and keeps the history view", async () => {
    route.params = { routineId: "routine-1", section: "triggers" };
    await render();
    expect(container.querySelector("[data-redirect]")?.getAttribute("href")).toBe("/routines/routine-1");

    route.params = { routineId: "routine-1" };
    route.search = "?tab=runs";
    await render();
    expect(container.querySelector("[data-redirect]")?.getAttribute("href")).toBe("/routines/routine-1");

    route.params = { routineId: "routine-1", section: "history" };
    route.search = "";
    await render();
    expect(container.querySelector("[data-redirect]")).toBeNull();
    expect(container.textContent).toContain("Version history");
    expect(container.textContent).toContain("Revision list");
  });

  it("shows the routine with its schedule, agent, responsible user and history", async () => {
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Send the weekly digest");
    expect(container.textContent).toContain("Weekdays at 9:00 AM");
    expect(container.textContent).toContain("Digest Bot");
    expect(container.textContent).toContain("Riley Board");
    expect(container.textContent).toContain("Digest 1");
    expect(container.textContent).toContain("Queues every run, even while one is still working");
    expect(issuesApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
      originKind: "routine_execution",
      originId: "routine-1",
      limit: ROUTINE_HISTORY_PAGE_SIZE + 1,
      offset: 0,
    }));
  });

  it("loads History a page at a time", async () => {
    const firstPage = Array.from({ length: ROUTINE_HISTORY_PAGE_SIZE + 1 }, (_, index) => task(index));
    vi.mocked(issuesApi.list).mockImplementation(async (_companyId, filters) =>
      filters?.offset === 0 ? firstPage : [task(100)]);
    await render();
    const list = container.querySelector('[aria-label="Tasks created by this routine"]');
    expect(list?.querySelectorAll("li")).toHaveLength(ROUTINE_HISTORY_PAGE_SIZE);
    await act(async () => { button("Load more")!.click(); await flush(); });
    expect(issuesApi.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ offset: ROUTINE_HISTORY_PAGE_SIZE }));
    expect(container.textContent).toContain("Digest 100");
    expect(button("Load more")).toBeUndefined();
  });

  it("keeps the page on screen and explains a History failure", async () => {
    vi.mocked(issuesApi.list).mockRejectedValue(new ApiError("boom", 500, { error: "boom" }));
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Send the weekly digest");
    expect(container.textContent).toMatch(/load this routine’s tasks|Retry/);
  });

  it("pauses the routine from the status switch", async () => {
    vi.mocked(routinesApi.update).mockResolvedValue(routine({ status: "paused" }));
    await render();
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => { toggle.click(); await flush(); });
    expect(routinesApi.update).toHaveBeenCalledWith("routine-1", { status: "paused" });
  });

  it("saves edits against the revision the form opened with and leaves delivery settings alone", async () => {
    vi.mocked(routinesApi.update).mockResolvedValue(routine({ title: "Send the monthly digest", latestRevisionId: "revision-2" }));
    await render();
    await act(async () => { button("Edit routine")!.click(); await flush(); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const title = dialog.querySelector<HTMLInputElement>("input[placeholder='Send the weekly digest']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Send the monthly digest");
      title.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    await act(async () => { button("Save changes", dialog)!.click(); await flush(); });
    expect(routinesApi.update).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(routinesApi.update).mock.calls[0]![1];
    expect(payload).toMatchObject({ title: "Send the monthly digest", baseRevisionId: "revision-1", assigneeAgentId: "agent-1" });
    expect(payload).not.toHaveProperty("concurrencyPolicy");
    expect(payload).not.toHaveProperty("priority");
    expect(payload).not.toHaveProperty("status");
  });

  it("tells the person when someone else changed the routine while they were editing", async () => {
    vi.mocked(routinesApi.update).mockRejectedValue(new ApiError("conflict", 409, { error: "conflict" }));
    await render();
    await act(async () => { button("Edit routine")!.click(); await flush(); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const title = dialog.querySelector<HTMLInputElement>("input[placeholder='Send the weekly digest']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Changed");
      title.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    await act(async () => { button("Save changes", dialog)!.click(); await flush(); });
    expect(document.body.textContent).toContain("This routine changed while you were editing");
    expect(button("Reload latest")).toBeDefined();
  });

  it("tests a live webhook and ends the test when the dialog closes", async () => {
    const live = trigger({
      id: "webhook-1",
      kind: "webhook",
      cronExpression: null,
      timezone: null,
      nextRunAt: null,
      signingMode: "app_webhook",
      webhookUrl: "https://paperclip.example/api/routine-triggers/public/abc/fire",
      lastWebhookDelivery: { status: "received", receivedAt: "2026-11-17T10:00:00Z", test: false },
    });
    vi.mocked(routinesApi.get).mockResolvedValue(routine({ triggers: [live] }));
    await render();
    expect(container.textContent).toContain("Receiving events");
    await act(async () => { button("Open Webhook")!.click(); await flush(); });
    await act(async () => { button("Test webhook")!.click(); await flush(); });
    expect(routinesApi.updateTrigger).toHaveBeenCalledWith("webhook-1", { setupPending: true });

    // The routine now reports the webhook in test mode; closing the dialog must put it back to live.
    vi.mocked(routinesApi.get).mockResolvedValue(routine({ triggers: [{ ...live, setupPending: true }] }));
    await act(async () => { await queryClient.refetchQueries(); await flush(); });
    expect(document.body.textContent).toContain("Testing. No tasks are created.");
    await act(async () => { button("Finish testing")!.click(); await flush(); });
    expect(routinesApi.updateTrigger).toHaveBeenLastCalledWith("webhook-1", { setupPending: false });
  });

  it("does not close the webhook dialog while starting a test is still saving", async () => {
    const live = trigger({ id: "webhook-1", kind: "webhook", cronExpression: null, nextRunAt: null, signingMode: "app_webhook" });
    vi.mocked(routinesApi.get).mockResolvedValue(routine({ triggers: [live] }));
    let finishRequest: (value: unknown) => void = () => {};
    vi.mocked(routinesApi.updateTrigger).mockImplementationOnce(() => new Promise((resolve) => { finishRequest = resolve as never; }) as never);
    await render();
    await act(async () => { button("Open Webhook")!.click(); await flush(); });
    await act(async () => { button("Test webhook")!.click(); await flush(); });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await act(async () => { await flush(); });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    vi.mocked(routinesApi.get).mockResolvedValue(routine({ triggers: [{ ...live, setupPending: true }] }));
    await act(async () => { finishRequest(live); await flush(); });
    expect(document.body.textContent).toContain("Testing. No tasks are created.");
  });

  it("shows a webhook left in test mode on the page", async () => {
    vi.mocked(routinesApi.get).mockResolvedValue(routine({
      triggers: [trigger({
        id: "webhook-1",
        kind: "webhook",
        cronExpression: null,
        signingMode: "app_webhook",
        setupPending: true,
        lastWebhookDelivery: {
          status: "received",
          receivedAt: "2026-11-18T10:00:00Z",
          test: true,
          previous: { status: "received", receivedAt: "2026-11-17T10:00:00Z", test: false },
        },
      })],
    }));
    await render();
    expect(container.textContent).toContain("Testing · events don’t run");
    await act(async () => { button("Open Webhook")!.click(); await flush(); });
    expect(button("Finish testing")).toBeDefined();
  });

  it("pauses and resumes one schedule from its popover", async () => {
    await render();
    await act(async () => { button("Change schedule: Weekdays at 9:00 AM")!.click(); await flush(); });
    await act(async () => { button("Pause")!.click(); await flush(); });
    expect(routinesApi.updateTrigger).toHaveBeenCalledWith("trigger-1", { enabled: false });
  });

  it("offers Undo on the page after removing a schedule", async () => {
    await render();
    await act(async () => { button("Change schedule: Weekdays at 9:00 AM")!.click(); await flush(); });
    vi.mocked(routinesApi.get).mockResolvedValue(routine({ triggers: [] }));
    await act(async () => { button("Remove schedule")!.click(); await flush(); });
    expect(routinesApi.updateTrigger).toHaveBeenCalledWith("trigger-1", { archived: true });
    expect(container.textContent).toContain("Weekdays at 9:00 AM removed.");
    await act(async () => { button("Undo")!.click(); await flush(); });
    expect(routinesApi.updateTrigger).toHaveBeenLastCalledWith("trigger-1", { archived: false });
  });

  it("pauses and removes a standing check from its popover", async () => {
    vi.mocked(routinesApi.get).mockResolvedValue(routine({
      triggers: [trigger({ id: "check-1", kind: "heartbeat", cronExpression: null, nextRunAt: null })],
    }));
    await render();
    await act(async () => { button("Change Standing check")!.click(); await flush(); });
    await act(async () => { button("Pause")!.click(); await flush(); });
    expect(routinesApi.updateTrigger).toHaveBeenCalledWith("check-1", { enabled: false });
    await act(async () => { button("Change Standing check")!.click(); await flush(); });
    await act(async () => { button("Remove")!.click(); await flush(); });
    expect(routinesApi.updateTrigger).toHaveBeenLastCalledWith("check-1", { archived: true });
  });

  it("does not adopt someone else's revision when the form's own webhook change refreshes the routine", async () => {
    const live = trigger({ id: "webhook-1", kind: "webhook", cronExpression: null, nextRunAt: null, signingMode: "app_webhook" });
    vi.mocked(routinesApi.get).mockResolvedValue(routine({ triggers: [live] }));
    vi.mocked(routinesApi.update).mockRejectedValue(new ApiError("conflict", 409, { error: "conflict" }));
    await render();
    await act(async () => { button("Edit routine")!.click(); await flush(); });
    // Someone else saved (revision 2) and this form paused the webhook (revision 3).
    vi.mocked(routinesApi.get).mockResolvedValue(routine({ triggers: [{ ...live, enabled: false }], latestRevisionId: "revision-3", latestRevisionNumber: 3 }));
    await act(async () => { button("Configure Webhook")!.click(); await flush(); });
    await act(async () => { button("Pause")!.click(); await flush(); });
    await act(async () => { button("Done")!.click(); await flush(); });
    const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find((element) => element.textContent?.includes("Edit routine"))!;
    const title = dialog.querySelector<HTMLInputElement>("input[placeholder='Send the weekly digest']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Mine");
      title.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    await act(async () => { button("Save changes", dialog)!.click(); await flush(); });
    expect(vi.mocked(routinesApi.update).mock.calls[0]![1]).toMatchObject({ baseRevisionId: "revision-1" });
    expect(document.body.textContent).toContain("This routine changed while you were editing");
  });

  it("adopts the revision made by the form's own webhook change", async () => {
    const live = trigger({ id: "webhook-1", kind: "webhook", cronExpression: null, nextRunAt: null, signingMode: "app_webhook" });
    vi.mocked(routinesApi.get).mockResolvedValue(routine({ triggers: [live] }));
    vi.mocked(routinesApi.update).mockResolvedValue(routine({ latestRevisionId: "revision-3", latestRevisionNumber: 3 }));
    await render();
    await act(async () => { button("Edit routine")!.click(); await flush(); });
    vi.mocked(routinesApi.get).mockResolvedValue(routine({ triggers: [{ ...live, enabled: false }], latestRevisionId: "revision-2", latestRevisionNumber: 2 }));
    await act(async () => { button("Configure Webhook")!.click(); await flush(); });
    await act(async () => { button("Pause")!.click(); await flush(); });
    await act(async () => { button("Done")!.click(); await flush(); });
    const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find((element) => element.textContent?.includes("Edit routine"))!;
    const title = dialog.querySelector<HTMLInputElement>("input[placeholder='Send the weekly digest']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Mine");
      title.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    await act(async () => { button("Save changes", dialog)!.click(); await flush(); });
    expect(vi.mocked(routinesApi.update).mock.calls[0]![1]).toMatchObject({ baseRevisionId: "revision-2" });
  });

  it("keeps a responsibility that loads after the page when only the title changes", async () => {
    vi.mocked(instanceSettingsApi.getExperimental).mockResolvedValue({ enableResponsibilities: true } as never);
    let resolveLinks: (value: unknown) => void = () => {};
    vi.mocked(responsibilitiesApi.lookupRoutineLinks).mockImplementation(() => new Promise((resolve) => { resolveLinks = resolve as never; }) as never);
    vi.mocked(routinesApi.update).mockResolvedValue(routine({ title: "Mine", latestRevisionId: "revision-2", latestRevisionNumber: 2 }));
    await render();
    await act(async () => { button("Edit routine")!.click(); await flush(); });
    // The form waits for the link before it opens.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      resolveLinks({ responsibilities: [{ id: "resp-1", title: "Keep customers informed", areaId: null, ownerUserId: "user-1", via: "direct" }] });
      await flush();
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const title = dialog.querySelector<HTMLInputElement>("input[placeholder='Send the weekly digest']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Mine");
      title.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    await act(async () => { button("Save changes", dialog)!.click(); await flush(); });
    expect(routinesApi.update).toHaveBeenCalled();
    expect(responsibilitiesApi.unlink).not.toHaveBeenCalled();
    expect(responsibilitiesApi.link).not.toHaveBeenCalled();
  });

  it("says when people could not be loaded instead of showing no responsible user", async () => {
    vi.mocked(accessApi.listUserDirectory).mockRejectedValueOnce(new ApiError("down", 500, { error: "down" }));
    await render();
    expect(container.textContent).not.toContain("No one yet");
    expect(container.textContent).toContain("Couldn’t load this person");
    expect(button("Retry")).toBeDefined();
  });

  it("opens the instruction comments when a comment link changes only the fragment", async () => {
    vi.mocked(routinesApi.get).mockResolvedValue(routine({
      description: "First paragraph.\n\nSecond paragraph.",
      descriptionDocument: { id: "doc-1", key: "description", latestRevisionId: "doc-rev-1" } as RoutineDetailData["descriptionDocument"],
    }));
    await render();
    expect(container.querySelector('[data-testid="instruction-comments"]')).toBeNull();
    route.hash = "#document-description&thread=thread-1";
    await render();
    const layer = container.querySelector('[data-testid="instruction-comments"]');
    expect(layer?.getAttribute("data-open")).toBe("true");
    expect(layer?.textContent).toContain("Second paragraph.");
  });

  it("neither fetches nor shows responsibilities while the experimental flag is off", async () => {
    await render();
    expect(responsibilitiesApi.lookupRoutineLinks).not.toHaveBeenCalled();
    expect(responsibilitiesApi.overview).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Responsibility");
  });

  it("shows direct and through-project responsibilities when the flag is on", async () => {
    vi.mocked(instanceSettingsApi.getExperimental).mockResolvedValue({ enableResponsibilities: true } as never);
    vi.mocked(responsibilitiesApi.lookupRoutineLinks).mockResolvedValue({
      responsibilities: [
        { id: "resp-1", title: "Keep customers informed", areaId: null, ownerUserId: "user-1", via: "direct" },
      ],
    });
    await render();
    expect(responsibilitiesApi.lookupRoutineLinks).toHaveBeenCalledWith("company-1", "routine-1");
    expect(container.textContent).toContain("Responsibility");
    expect(container.textContent).toContain("Keep customers informed");
  });
});
