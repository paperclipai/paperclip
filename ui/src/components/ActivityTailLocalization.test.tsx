// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent, Agent, PipelineCaseLiveness } from "@paperclipai/shared";
import type { CaseEvent, CaseAttachmentRef } from "@/api/cases";
import { i18n, t, useTranslation } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import { derivePipelineLivenessBanner, shouldDisableRerunForPermission } from "@/lib/pipeline-liveness";
import { extractWorkReferences, referenceFieldKeys } from "@/lib/pipeline-references";
import { CaseActivityFeed, CaseEventRow } from "./CaseActivityFeed";
import { CaseChildrenTree } from "./CaseChildrenTree";
import { CaseCopyableToken, CaseIdentifierKey } from "./CaseIdentifierKey";
import { CaseAttachmentsGallery } from "./CaseAttachmentsGallery";
import { IssueCasesPanel } from "./IssueCasesPanel";
import { PipelineLivenessBanner } from "./PipelineLivenessBanner";
import { PipelineWorkReferences } from "./PipelineWorkReferences";
import { FeedCard } from "./FeedCard";
import { LiveRunWidget } from "./LiveRunWidget";

const mocks = vi.hoisted(() => ({ copy: vi.fn().mockResolvedValue(undefined), cancel: vi.fn(), live: vi.fn(), active: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: mocks.copy }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, issueQuicklookSide: _side, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; issueQuicklookSide?: string }) => <a href={to} {...props}>{children}</a>,
  useCaseHref: () => (id: string) => `/cases/${id}`,
}));
vi.mock("@/lib/polling", () => ({ useVisibilityRefetchInterval: () => false }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { cancel: mocks.cancel, liveRunsForIssue: mocks.live, activeRunForIssue: mocks.active } }));
vi.mock("./transcript/useLiveRunTranscripts", () => ({ useLiveRunTranscripts: () => ({ transcriptByRun: new Map(), hasOutputForRun: () => true }) }));
vi.mock("./RunChatSurface", () => ({ RunChatSurface: ({ run }: { run: { id: string } }) => <div data-run={run.id}>RAW_TOOL_OUTPUT</div> }));
vi.mock("./ImageGalleryModal", () => ({ ImageGalleryModal: ({ initialIndex, items }: { initialIndex: number; items: Array<{ originalFilename: string | null }> }) => <div data-gallery-index={initialIndex}>{items[initialIndex]?.originalFilename}</div> }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;
let client: QueryClient | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  client?.clear();
  root = undefined;
  client = undefined;
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
});
async function locale(language: "en" | "ru") { await act(async () => { await i18n.changeLanguage(language); }); }
async function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
}
function queryClient() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return client;
}
function caseEvent(overrides: Partial<CaseEvent> = {}): CaseEvent {
  return { id: "raw-event", caseId: "raw-case", kind: "created", actorType: "system", actorUserId: null, actorAgentId: null, runId: null, payload: {}, createdAt: "2026-07-07T00:00:00Z", actorAgentName: null, issue: null, ...overrides };
}
function feedEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return { id: "raw-event", companyId: "raw-company", actorType: "agent", actorId: "raw-agent", agentId: "raw-agent", runId: null, entityType: "issue", entityId: "raw-issue", action: "issue.created", details: null, createdAt: new Date("2026-07-07T00:00:00Z"), ...overrides };
}
const agentMap = new Map([["raw-agent", { id: "raw-agent", name: "Board" } as Agent]]);
const entityNameMap = new Map([["issue:raw-issue", "PAP-42"]]);
const entityTitleMap = new Map([["issue:raw-issue", "RAW_TITLE"]]);
const button = (text: string) => Array.from(container.querySelectorAll("button")).find((el) => el.textContent?.includes(text))!;

describe("Activity tail locale boundaries", () => {
  it.each([[1, "1 фильтр", "1 ожидаемой части"], [2, "2 фильтра", "2 ожидаемых частей"], [5, "5 фильтров", "5 ожидаемых частей"], [21, "21 фильтр", "21 ожидаемой части"], [22, "22 фильтра", "22 ожидаемых частей"], [25, "25 фильтров", "25 ожидаемых частей"], [1.5, "1,5 фильтра", "1,5 ожидаемой части"]])("uses natural plural/count display for %s", async (count, filters, pieces) => {
    await locale("ru");
    const value = new Intl.NumberFormat(i18n.resolvedLanguage).format(count);
    expect(t("localizationActivityTail.filters", { count, value })).toBe(filters);
    expect(t("localizationActivityTail.missingPieces", { count, value, message: "RAW_MESSAGE" })).toBe(`RAW_MESSAGE Не хватает ещё ${pieces}.`);
  });

  it("preserves a selected activity filter and raw events across locale changes", async () => {
    const events = [caseEvent(), caseEvent({ id: "status-event", kind: "status_changed", payload: { previousStatus: "draft", status: "in_review" } })];
    const before = JSON.stringify(events);
    await mount(<CaseActivityFeed events={events} />);
    expect(container.textContent).toContain("Draft → In Review");
    await act(async () => button("All activity").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    const created = Array.from(document.body.querySelectorAll('[role="menuitemcheckbox"]')).find((el) => el.textContent === "created")!;
    await act(async () => created.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await locale("ru");
    expect(container.textContent).toContain("События: 1 из 2");
    expect(container.textContent).not.toContain("→");
    expect(container.textContent).toContain("создание материала");
    expect(JSON.stringify(events)).toBe(before);
    await locale("en");
    expect(container.textContent).toContain("1 of 2 events");
  });

  it("localizes event chrome but keeps custom status, actor, issue title and route", async () => {
    const event = caseEvent({ kind: "status_changed", actorType: "agent", actorAgentName: "RAW_AGENT", payload: { previousStatus: "CUSTOM_STATE", status: "in_review" }, issue: { id: "raw-issue", identifier: "PAP-42", title: "RAW_TITLE", status: "todo" } });
    await mount(<CaseEventRow event={event} />);
    await locale("ru");
    expect(container.textContent).toContain("изменение статуса");
    expect(container.textContent).toContain("CUSTOM_STATE → На проверке");
    expect(container.textContent).toContain("RAW_AGENT");
    expect(container.querySelector('a[href="/issues/PAP-42"]')?.textContent).toContain("RAW_TITLE");
  });

  it("keeps expanded children and copies canonical identifiers", async () => {
    const children = Array.from({ length: 3 }, (_, index) => ({ id: String(index), identifier: `RAW-${index}`, title: `RAW_TITLE_${index}`, caseType: "blog_post", status: "in_review" as const }));
    await mount(<CaseChildrenTree children={children} maxVisible={1} />);
    await act(async () => button("Show 2 more").click());
    await locale("ru");
    expect(container.querySelectorAll("a")).toHaveLength(3);
    expect(container.textContent).toContain("blog_post");
    expect(container.querySelector('a[href="/cases/RAW-2"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="RAW-2"]')!.click());
    expect(mocks.copy).toHaveBeenCalledExactlyOnceWith("RAW-2");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Скопировано");
    await locale("en");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Copied");
    expect(container.querySelectorAll("a")).toHaveLength(3);
  });

  it("localizes copy accessibility without changing custom labels or values", async () => {
    await mount(<><CaseIdentifierKey identifier="RAW-ID" caseKey="raw/key" /><CaseCopyableToken value="RAW_VALUE" label="Custom title" /></>);
    await locale("ru");
    expect(container.querySelector('button[title="RAW-ID"]')?.getAttribute("aria-label")).toBe("Скопировать ID материала: RAW-ID");
    expect(container.querySelector('button[title="raw/key"]')?.getAttribute("aria-label")).toBe("Скопировать ключ материала: raw/key");
    expect(container.querySelector('button[title="RAW_VALUE"]')?.getAttribute("aria-label")).toBe("Скопировать Custom title: RAW_VALUE");
  });

  it("keeps an open image gallery and raw filename while formatting bytes", async () => {
    const attachments: CaseAttachmentRef[] = [
      { id: "attachment-1", asset: { id: "asset-1", contentType: "image/png", byteSize: 1.5 * 1024 * 1024, originalFilename: "RAW.png" }, createdAt: "", updatedAt: "" },
      { id: "attachment-2", asset: { id: "asset-2", contentType: "text/plain", byteSize: 100, originalFilename: null }, createdAt: "", updatedAt: "" },
    ];
    const before = JSON.stringify(attachments);
    await mount(<CaseAttachmentsGallery attachments={attachments} />);
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="RAW.png"]')!.click());
    await locale("ru");
    expect(container.textContent).toContain("1,5 МБ");
    expect(container.textContent).toContain("100 Б");
    expect(container.querySelector('[data-gallery-index="0"]')?.textContent).toBe("RAW.png");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/assets/asset-1/content");
    expect(container.querySelector('button[title="вложение"]')).not.toBeNull();
    expect(JSON.stringify(attachments)).toBe(before);
  });

  it("keeps linked case roles and query data canonical", async () => {
    const qc = queryClient();
    qc.setQueryData(queryKeys.instance.experimentalSettings, { enableCases: true });
    const links = [{ id: "raw-link", role: "origin", case: { id: "raw-case", identifier: "RAW-C1", title: "RAW_TITLE", status: "draft", caseType: "blog_post" } }];
    qc.setQueryData(queryKeys.cases.forIssue("raw-issue"), links);
    await mount(<QueryClientProvider client={qc}><IssueCasesPanel issueId="raw-issue" /></QueryClientProvider>);
    await locale("ru");
    expect(container.textContent).toContain("Материалы");
    expect(container.textContent).toContain("источник");
    expect(container.querySelector('a[href="/cases/RAW-C1"]')?.textContent).toContain("RAW_TITLE");
    expect(qc.getQueryData(queryKeys.cases.forIssue("raw-issue"))).toEqual(links);
  });

  it.each([
    ["issue.created", "создание задачи"],
    ["issue.document_deleted", "удаление документа из задачи"],
    ["approval.created", "запрос на согласование"],
    ["agent.created", "найм агента"],
    ["heartbeat.invoked", "начало запуска"],
    ["project.created", "создание проекта"],
    ["company.budget_updated", "обновление бюджета организации"],
  ])("renders a full grammatical FeedCard sentence for %s", async (action, label) => {
    const event = feedEvent({ action });
    const before = JSON.stringify(event);
    await mount(<FeedCard event={event} agentMap={agentMap} entityNameMap={entityNameMap} entityTitleMap={entityTitleMap} />);
    await locale("ru");
    expect(container.textContent).toContain(`Board: ${label} — PAP-42RAW_TITLE`);
    expect(container.querySelector('[data-fc="actor"]')?.textContent).toBe("Board");
    expect(container.querySelector('a[href="/issues/PAP-42"]')).not.toBeNull();
    expect(JSON.stringify(event)).toBe(before);
    await locale("en");
    expect(container.querySelector('[data-fc="actor"]')?.textContent).toBe("Board");
  });

  it("localizes pinned approval types and preserves unknown record identifiers", async () => {
    const event = feedEvent({ action: "approval.created", entityType: "approval", entityId: "raw-approval", details: { type: "hire_agent" } });
    await mount(<FeedCard event={event} agentMap={agentMap} entityNameMap={new Map()} isPinned />);
    await locale("ru");
    expect(container.textContent).toContain("Board: требуется согласование — найм агента");
    expect(container.textContent).toContain("Рассмотреть →");
    expect(container.querySelector('a[href="/approvals/raw-approval"]')).not.toBeNull();
    await act(async () => root!.render(<FeedCard event={feedEvent({ details: { status: "CUSTOM_STATUS" }, action: "issue.updated" })} agentMap={agentMap} entityNameMap={entityNameMap} />));
    expect(container.textContent).toContain("смена статуса на «CUSTOM STATUS»");
  });

  it("localizes liveness chrome without changing server errors, permissions or retry decisions", async () => {
    const liveness: PipelineCaseLiveness = { state: "blocked", reason: "permission_preflight_failed", message: "RAW_SERVER_MESSAGE", automation: { fingerprint: "raw:pipelines:write" }, issue: { id: "raw-issue", identifier: "PAP-42", title: "RAW_TITLE", status: "blocked" } };
    const before = JSON.stringify(liveness);
    const retry = vi.fn();
    await mount(<PipelineLivenessBanner liveness={liveness} onRetry={retry} retryError="RAW_ERROR" />);
    await locale("ru");
    expect(container.textContent).toContain("Для запуска нужно разрешение");
    expect(container.textContent).toContain("RAW_SERVER_MESSAGE");
    expect(container.textContent).toContain("RAW_ERROR");
    expect(container.querySelector("code")?.textContent).toBe("pipelines:write");
    expect(container.textContent).toContain("Для целевого конвейера нужно разрешение pipelines:write.");
    expect(shouldDisableRerunForPermission(liveness)).toBe(true);
    expect(container.querySelector("button")).toBeNull();
    expect(retry).not.toHaveBeenCalled();
    expect(JSON.stringify(liveness)).toBe(before);
  });

  it("preserves recovered automation retry scope and missing-piece payloads", async () => {
    const liveness: PipelineCaseLiveness = { state: "attention", reason: "automation_failed", message: "Permission has been restored RAW_SUFFIX", automation: { automationId: "raw-automation" } };
    const retry = vi.fn();
    await mount(<PipelineLivenessBanner liveness={liveness} onRetry={retry} />);
    await locale("ru");
    expect(container.textContent).toContain("Препятствие устранено — можно повторить попытку");
    expect(retry).not.toHaveBeenCalled();
    await act(async () => button("Повторить сейчас").click());
    expect(retry).toHaveBeenCalledExactlyOnceWith("automation");
    const breakdown: PipelineCaseLiveness = { state: "blocked", reason: "breakdown_incomplete", message: "RAW_MESSAGE", breakdown: { missingRequestKeys: ["RAW_A", "RAW_B"] } };
    expect(derivePipelineLivenessBanner(breakdown)?.body).toBe("RAW_MESSAGE Не хватает ещё 2 ожидаемых частей.");
    expect(breakdown.breakdown?.missingRequestKeys).toEqual(["RAW_A", "RAW_B"]);
  });

  it("translates generated workspace labels but preserves custom fields, paths and links", async () => {
    const item = { workspaceRef: { path: "/RAW_PATH", branch: "RAW_BRANCH" }, fields: { docsLink: { kind: "url", label: "Workspace folder", url: "https://example.invalid/RAW" }, customField: "RAW_VALUE" } };
    const before = JSON.stringify(item);
    function References() {
      const { t: _t } = useTranslation();
      return <PipelineWorkReferences references={extractWorkReferences(item)} />;
    }
    await mount(<References />);
    await locale("ru");
    expect(container.textContent).toContain("Папка рабочей области");
    expect(container.textContent).toContain("Workspace folder");
    expect(container.textContent).toContain("/RAW_PATH");
    expect(container.textContent).toContain("RAW_BRANCH");
    expect(container.querySelector('a[href="https://example.invalid/RAW"]')).not.toBeNull();
    expect([...referenceFieldKeys(item.fields)]).toEqual(["docsLink"]);
    expect(JSON.stringify(item)).toBe(before);
  });

  it("keeps an in-flight stop action across locale changes without rerunning it", async () => {
    const qc = queryClient();
    const run = { id: "raw-run", status: "running", invocationSource: "raw-source", triggerDetail: null, startedAt: "2026-07-07T00:00:00Z", finishedAt: null, createdAt: "2026-07-07T00:00:00Z", agentId: "raw-agent", agentName: "RAW_AGENT", adapterType: "raw_adapter", issueId: "raw-issue" };
    qc.setQueryData(queryKeys.issues.liveRuns("raw-issue"), [run]);
    qc.setQueryData(queryKeys.issues.activeRun("raw-issue"), null);
    let finish!: () => void;
    mocks.cancel.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await mount(<QueryClientProvider client={qc}><LiveRunWidget issueId="raw-issue" companyId="raw-company" /></QueryClientProvider>);
    await act(async () => button("Stop").click());
    await locale("ru");
    expect(button("Остановка…").disabled).toBe(true);
    expect(container.textContent).toContain("Текущие запуски");
    expect(container.textContent).toContain("RAW_TOOL_OUTPUT");
    expect(container.querySelector('a[href="/agents/raw-agent/runs/raw-run"]')).not.toBeNull();
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith("raw-run");
    expect(mocks.live).not.toHaveBeenCalled();
    expect(mocks.active).not.toHaveBeenCalled();
    await act(async () => finish());
  });
});
