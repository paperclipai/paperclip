// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent, Issue } from "@paperclipai/shared";
import { i18n, t } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import { groupInboxWorkItems, getInboxWorkItems, resolveIssueWorkspaceGroup } from "@/lib/inbox";
import { formatLearningEvent, learningDayKey, learningDayLabel } from "@/lib/pipeline-learnings";
import type { PipelineCompanyCaseEvent } from "@/api/pipelines";
import { ActivityFeed } from "./ActivityFeed";
import { CaseFieldValue, CaseFieldsPanel } from "./CaseFieldsPanel";
import { DashboardLive } from "@/pages/DashboardLive";
import { TooltipProvider } from "./ui/tooltip";

const mocks = vi.hoisted(() => ({ copy: vi.fn().mockResolvedValue(undefined), breadcrumbs: vi.fn() }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-raw", companies: [{ id: "company-raw" }] }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }) }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: mocks.copy }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>,
  useCaseHref: () => (id: string) => `/cases/${id}`,
}));
vi.mock("./FeedCard", () => ({ FeedCard: ({ event }: { event: ActivityEvent }) => <div data-testid="raw-feed-event">{event.id}</div> }));
vi.mock("./IssueReferencePill", () => ({ IssueReferencePill: ({ issue }: { issue: Issue }) => <span>{issue.identifier}</span> }));
vi.mock("./ActiveAgentsPanel", () => ({ ActiveAgentsPanel: (props: { title: string; emptyMessage: string; fetchLimit: number; companyId: string }) => <div data-testid="run-panel" data-limit={props.fetchLimit} data-company={props.companyId}>{props.title} {props.emptyMessage}</div> }));
vi.mock("@/hooks/useSharedPolling", () => ({ useSharedPollingQuery: () => ({ enabled: false, refetchInterval: false }), usePublishSharedQueryData: () => {} }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let client: QueryClient | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  client?.clear();
  root = undefined;
  container = undefined;
  client = undefined;
  mocks.copy.mockClear();
  mocks.breadcrumbs.mockClear();
  await i18n.changeLanguage("en");
});
async function locale(lang: "en" | "ru") { await act(async () => { await i18n.changeLanguage(lang); }); }
async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
}

function learningEvent(overrides: Partial<PipelineCompanyCaseEvent>): PipelineCompanyCaseEvent {
  return {
    id: "raw-event", companyId: "company-raw", caseId: "case-raw", type: "review_decided", actorType: "agent",
    createdAt: new Date(), updatedAt: new Date(),
    case: { id: "case-raw", caseKey: "RAW_KEY", title: "RAW_TITLE" },
    pipeline: { id: "pipeline-raw", key: "RAW_PIPELINE", name: "RAW_PIPELINE_NAME" },
    actorAgent: { id: "agent-raw", name: "RAW_ACTOR" },
    fromStage: { id: "from-raw", key: "RAW_FROM_KEY", name: "RAW_FROM", kind: "work" },
    toStage: { id: "to-raw", key: "RAW_TO_KEY", name: "RAW_STAGE", kind: "work" },
    ...overrides,
  };
}

describe("Activity chrome", () => {
  it.each([[1, "1 изменение"], [2, "2 изменения"], [5, "5 изменений"], [21, "21 изменение"], [22, "22 изменения"], [25, "25 изменений"]])("uses full Russian activity count templates for %i", async (count, expected) => {
    await locale("ru");
    const text = t("localizationActivityChrome.collapsedUpdates", { count, actorName: "RAW_ACTOR", entityName: "PAP-1" });
    expect(text).toContain(expected);
    expect(text).toContain("RAW_ACTOR");
    expect(text).toContain("PAP-1");
  });

  it("keeps a mounted activity group expanded across locale changes", async () => {
    client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const events: ActivityEvent[] = Array.from({ length: 3 }, (_, index) => ({ id: `raw-event-${index}`, companyId: "company-raw", actorType: "agent", actorId: "agent-raw", agentId: "agent-raw", runId: null, entityType: "issue", entityId: "issue-raw", action: "issue.updated", details: { title: "RAW_USER_TITLE" }, createdAt: new Date(Date.now() - index * 1000) }));
    const before = JSON.stringify(events);
    client.setQueryData(queryKeys.activity("company-raw"), events);
    client.setQueryData(queryKeys.agents.list("company-raw"), [{ id: "agent-raw", name: "RAW_AGENT", status: "idle" }]);
    client.setQueryData(queryKeys.issues.list("company-raw"), [{ id: "issue-raw", identifier: "PAP-1", title: "RAW_USER_TITLE", status: "in_progress" }]);
    await mount(<QueryClientProvider client={client}><TooltipProvider><ActivityFeed /></TooltipProvider></QueryClientProvider>);
    const group = container!.querySelector<HTMLButtonElement>('[data-fc="card"]')!;
    expect(group.textContent).toContain("made 3 updates to");
    await act(async () => group.click());
    expect(container?.querySelectorAll('[data-testid="raw-feed-event"]')).toHaveLength(3);
    await locale("ru");
    expect(container?.textContent).toContain("Лента агентов");
    expect(group.textContent).toContain("RAW_AGENT");
    expect(group.textContent).toContain("3 изменения");
    expect(group.textContent).toContain("PAP-1");
    expect(container?.querySelectorAll('[data-testid="raw-feed-event"]')).toHaveLength(3);
    await locale("en");
    expect(container?.querySelectorAll('[data-testid="raw-feed-event"]')).toHaveLength(3);
    expect(JSON.stringify(client.getQueryData(queryKeys.activity("company-raw")))).toBe(before);
  });

  it("updates dashboard breadcrumbs and panel chrome without changing query limits or company", async () => {
    await mount(<DashboardLive />);
    await locale("ru");
    expect(container?.textContent).toContain("Текущие запуски агентов");
    expect(container?.textContent).toContain("Показано не более 50");
    expect(container?.querySelector('[data-testid="run-panel"]')?.getAttribute("data-limit")).toBe("50");
    expect(container?.querySelector('[data-testid="run-panel"]')?.getAttribute("data-company")).toBe("company-raw");
    expect(mocks.breadcrumbs).toHaveBeenLastCalledWith([{ label: "Обзор", href: "/dashboard" }, { label: "Текущие запуски" }]);
  });

  it("localizes case-field chrome and number display while copying canonical raw values", async () => {
    const fields = { UserKey: "RAW_TEXT", precision: 0.00000123, custom: { raw_key: "RAW_JSON" }, bool: true };
    const before = JSON.stringify(fields);
    await mount(<><CaseFieldsPanel fields={fields} /><CaseFieldValue value={fields.precision} variant="compact" /></>);
    const copy = container!.querySelector<HTMLButtonElement>('button[title="0.00000123"]')!;
    await act(async () => copy.click());
    expect(mocks.copy).toHaveBeenCalledExactlyOnceWith("0.00000123");
    await locale("ru");
    expect(container?.textContent).toContain("Поля");
    expect(container?.textContent).toContain("Скопировано");
    expect(container?.textContent).toContain("0,00000123");
    expect(container?.textContent).toContain("UserKey");
    expect(container?.textContent).toContain("RAW_TEXT");
    expect(container?.textContent).toContain('"raw_key": "RAW_JSON"');
    expect(JSON.stringify(fields)).toBe(before);
    expect(mocks.copy).toHaveBeenCalledTimes(1);
  });

  it("localizes inbox fallback groups without changing IDs, raw names or stored values", async () => {
    const issue = { id: "issue-raw", title: "RAW_TITLE", projectId: "project-raw", executionWorkspaceId: null, projectWorkspaceId: null, assigneeAgentId: null, assigneeUserId: null, createdAt: new Date(), updatedAt: new Date() } as Issue;
    const options = { defaultProjectWorkspaceIdByProjectId: new Map([["project-raw", "workspace-raw"]]), projectWorkspaceById: new Map([["workspace-raw", { name: "Custom workspace" }]]) };
    const before = JSON.stringify(issue);
    expect(resolveIssueWorkspaceGroup(issue, options)).toEqual({ key: "workspace:project:workspace-raw", label: "Custom workspace (default)" });
    await locale("ru");
    expect(resolveIssueWorkspaceGroup(issue, options)).toEqual({ key: "workspace:project:workspace-raw", label: "Custom workspace (по умолчанию)" });
    const grouped = groupInboxWorkItems(getInboxWorkItems({ issues: [issue], approvals: [] }), "assignee");
    expect(grouped[0]?.key).toBe("assignee:none");
    expect(grouped[0]?.label).toBe("Не назначен");
    expect(grouped[0]?.items[0]).toMatchObject({ kind: "issue", issue: { id: "issue-raw", title: "RAW_TITLE" } });
    expect(JSON.stringify(issue)).toBe(before);
  });
});

describe("Pipeline learning display", () => {
  it.each(["approve", "request_changes", "reject", "drop"])("renders full review phrases for %s without translating records", async decision => {
    const event = learningEvent({ payload: { decision, reason: "RAW_NOTE" } });
    const before = JSON.stringify(event);
    const verb = decision === "request_changes" ? "sent back" : decision === "reject" || decision === "drop" ? "declined" : "approved";
    expect(formatLearningEvent(event).sentence).toBe(`RAW_ACTOR ${verb} 'RAW_TITLE' moving to RAW_STAGE - note: RAW_NOTE.`);
    await locale("ru");
    const expected = decision === "request_changes" ? "возвращён на доработку" : decision === "reject" || decision === "drop" ? "отклонён" : "одобрен";
    expect(formatLearningEvent(event)).toEqual({ kind: "review", sentence: `RAW_ACTOR: элемент «RAW_TITLE» ${expected}; переход на этап «RAW_STAGE»; примечание: RAW_NOTE.` });
    expect(JSON.stringify(event)).toBe(before);
  });
  it("retains forced-move origins, destinations and reasons plus canonical invalid-day keys", async () => {
    const event = learningEvent({ type: "transition_forced", toStage: { id: "to-raw", key: "RAW_TO_KEY", name: "RAW_TO", kind: "work" }, payload: { reason: "RAW_REASON" } });
    await locale("ru");
    expect(formatLearningEvent(event)).toEqual({ kind: "forced_move", sentence: "Элемент «RAW_TITLE» перемещён вручную с этапа «RAW_FROM» на этап «RAW_TO»; причина: RAW_REASON." });
    expect(learningDayKey("invalid")).toBe("Unknown");
    expect(learningDayLabel("invalid")).toBe("Дата неизвестна");
    expect(learningDayLabel(new Date())).toBe("Сегодня");
  });
});
