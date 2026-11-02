// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueBlockerAttention, IssueScheduledRetry } from "@paperclipai/shared";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { ToastProvider } from "@/context/ToastContext";
import { StatusIcon } from "./StatusIcon";
import { KanbanBoard, resolveKanbanTargetStatus } from "./KanbanBoard";
import { IssueScheduledRetryCard } from "./IssueScheduledRetryCard";
import { RETRY_NOW_OUTCOME_HEADLINE } from "@/hooks/useRetryNowMutation";
import { IssueFieldChangeReceipt } from "./IssueFieldChangeReceipt";
import { readIssueChangeReceipt, readIssueChangeReceiptDisplay } from "@/lib/issue-change-receipt";
import { SourceResolvedFoldCallout } from "./SourceResolvedFoldCallout";
import { parseSourceResolvedWatchdogFold, formatCleanupOutcome, formatSilenceAgeMs } from "@/lib/source-resolved-watchdog-fold";
import { DocumentDiffModal } from "./DocumentDiffModal";
import { DocumentFrameHeader } from "./DocumentFrameHeader";
import { OutputPrimaryCard } from "./issue-output/OutputPrimaryCard";
import type { IssueOutputItem } from "@/lib/issue-output";

const mocks = vi.hoisted(() => ({ query: vi.fn(), retry: vi.fn() }));
vi.mock("@tanstack/react-query", async () => ({
  ...await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query"),
  useQuery: (options: unknown) => mocks.query(options),
}));
vi.mock("@/api/issues", () => ({ issuesApi: { retryScheduledRetryNow: (...args: unknown[]) => mocks.retry(...args) } }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, disableIssueQuicklook: _q, ...props }: ComponentProps<"a"> & { to: string; disableIssueQuicklook?: boolean }) => <a href={to} {...props}>{children}</a> }));
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: ReactNode }) => <select value={value} onChange={(event) => onValueChange(event.target.value)}>{children}</select>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}));
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
async function locale(language: "ru" | "en") { await act(async () => { await i18n.changeLanguage(language); }); }
async function render(node: ReactNode) { await act(async () => root.render(<QueryClientProvider client={client}><ToastProvider>{node}</ToastProvider></QueryClientProvider>)); }
async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => { (element as HTMLElement).click(); });
}
function button(text: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mocks.query.mockReset().mockReturnValue({ data: undefined });
  mocks.retry.mockReset();
  await locale("ru");
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); client.clear(); vi.restoreAllMocks(); await locale("en");
});
describe("issue panels runtime localization", () => {
  it("retains the status picker and raw status callback with correct blocked plurals", async () => {
    const change = vi.fn();
    const attention: IssueBlockerAttention = { state: "covered", reason: "active_child", unresolvedBlockerCount: 21, coveredBlockerCount: 21, attentionBlockerCount: 0, stalledBlockerCount: 0, sampleBlockerIdentifier: null, sampleStalledBlockerIdentifier: null };
    await render(<StatusIcon status="blocked" blockerAttention={attention} onChange={change} />);
    const trigger = host.querySelector("button")!;
    expect(trigger.getAttribute("aria-label")).toContain("21 активной подзадачи");
    const glyph = trigger.querySelector("svg")!;
    expect(glyph.getAttribute("style")).toContain("--status-task-icon-in_queue");
    await click(trigger);
    await locale("en");
    expect(trigger.getAttribute("aria-label")).toContain("21 active sub-tasks");
    expect(document.querySelector('[data-slot="popover-content"]')).toBeTruthy();
    await locale("ru");
    expect(host.querySelector("button")).toBe(trigger);
    await click([...document.querySelectorAll('[data-slot="popover-content"] button')].find((item) => item.textContent?.includes(i18n.t("status.done"))));
    expect(change).toHaveBeenCalledWith("done");
    for (const [count, expected] of [[1, "1 блокирующая задача требует"], [2, "2 блокирующие задачи требуют"], [5, "5 блокирующих задач требуют"], [21, "21 блокирующая задача требует"]] as const) {
      expect(i18n.t("localizationIssuePanels.blockedAttention", { count })).toContain(expected);
    }
  });

  it("keeps kanban pagination and raw target classification across language switches", async () => {
    const issues = Array.from({ length: 21 }, (_, n) => ({ id: "issue-" + n, identifier: "RAW-" + n, title: "Original task " + n, status: "todo", parentId: null })) as Issue[];
    const update = vi.fn();
    await render(<KanbanBoard issues={issues} onUpdateIssue={update} initialVisibleCount={10} revealIncrement={10} />);
    await click(button("Показать ещё 10"));
    const first = host.querySelector('a[href="/issues/RAW-0"]')!;
    expect(host.textContent).toContain("Показано: 20 из 21");
    await locale("en");
    expect(host.textContent).toContain("Showing 20 of 21");
    expect(host.contains(first)).toBe(true);
    await locale("ru");
    await click(button("Показать ещё 1"));
    expect(host.textContent).toContain("Original task 20");
    expect(resolveKanbanTargetStatus("issue-0", issues)).toBe("todo");
    expect(resolveKanbanTargetStatus("done", issues)).toBe("done");
    expect(update).not.toHaveBeenCalled();
    expect(issues[0].status).toBe("todo");
  });

  it("keeps pending retry state, links and raw outcome values", async () => {
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let resolve: (value: unknown) => void = () => {};
    mocks.retry.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const retry = { status: "scheduled_retry", agentId: "agent-raw", retryOfRunId: "run-raw-12345", scheduledRetryAt: new Date(now + 900000).toISOString(), scheduledRetryAttempt: 21, scheduledRetryReason: "max_turns_continuation", error: "Original server error" } as IssueScheduledRetry;
    const original = structuredClone(retry);
    await render(<IssueScheduledRetryCard issueId="issue-raw" scheduledRetry={retry} />);
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="issue-scheduled-retry-card-retry-now"]')!;
    const link = host.querySelector('a[href="/agents/agent-raw/runs/run-raw-12345"]')!;
    expect(link.textContent).toBe("run-raw-");
    expect(host.textContent).toContain("Продолжение запланировано");
    await click(trigger);
    await locale("en");
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toContain("Retrying");
    await locale("ru");
    expect(host.contains(link)).toBe(true);
    await act(async () => { resolve({ outcome: "promoted", message: "Raw API response", scheduledRetry: null }); });
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(trigger.disabled).toBe(true);
    expect(mocks.retry).toHaveBeenCalledWith("issue-raw");
    expect(retry).toEqual(original);
    expect(RETRY_NOW_OUTCOME_HEADLINE.promoted).toBe("Retry promoted");
  });

  it("localizes receipt values without changing raw parsing, row order or source previews", async () => {
    const details = { authorizationReason: "allow_explicit_grant", changes: {
      status: { from: "todo", to: "in_progress" },
      description: { from: "Original description", to: "Keep **Markdown**", updated: true },
      labelIds: { from: [], to: Array.from({ length: 21 }, (_, n) => "label-" + n) },
      customField: { from: { raw: 1 }, to: { raw: 2 } },
    } };
    const raw = readIssueChangeReceipt(details);
    await render(<IssueFieldChangeReceipt event={{ action: "issue.updated", details, responsibleUserId: "user-raw" }} resolveUserLabel={() => "Original Name"} />);
    const row = host.querySelector('[data-testid="issue-change-row-description"]')!;
    expect(host.textContent).toContain("21 элемент");
    expect(host.textContent).toContain("Основание доступа");
    await locale("en");
    expect(host.textContent).toContain("authorized by explicit permission grant");
    expect(host.contains(row)).toBe(true);
    await locale("ru");
    expect(host.textContent).toContain("Keep **Markdown**");
    expect(readIssueChangeReceipt(details)).toEqual(raw);
    expect(readIssueChangeReceiptDisplay(details).map((item) => item.field)).toEqual(raw.map((item) => item.field));
  });

  it("projects watchdog outcomes, durations and dates without changing evidence", async () => {
    const source = { sourceIssueId: "issue-raw", sourceIssueIdentifier: "RAW-1", sourceIssueStatus: "done", sameRunEvidenceKind: "raw_protocol_kind", sameRunEvidenceId: "evidence-123456789", sameRunEvidenceAt: "2026-01-01T00:00:00Z", silenceAgeMs: 120000, cleanup: { attempted: true, outcome: "termination_sent_still_running", error: "Original failure" } };
    const fold = parseSourceResolvedWatchdogFold(source)!;
    const original = structuredClone(fold);
    await render(<SourceResolvedFoldCallout fold={fold} />);
    const link = host.querySelector('a[href="/issues/RAW-1"]')!;
    expect(host.textContent).toContain("2 минуты");
    expect(host.textContent).toContain("процесс ещё работает");
    await locale("en");
    expect(host.textContent).toContain("2 minutes");
    await locale("ru");
    expect(host.contains(link)).toBe(true);
    expect(host.textContent).toContain("raw_protocol_kind");
    expect(host.textContent).toContain("Original failure");
    expect(fold).toEqual(original);
    expect(formatCleanupOutcome(fold.cleanup.outcome)).toBe("termination sent (still running)");
    expect(formatSilenceAgeMs(120000)).toBe("2 minutes");
  });

  it("retains selected revision IDs and diff content while headers translate", async () => {
    const revisions = [1, 2, 3].map((revisionNumber) => ({ id: "revision-" + revisionNumber, revisionNumber, createdAt: new Date("2026-01-01T00:00:00Z"), createdByAgentId: "agent-raw", body: "Original line " + revisionNumber }));
    mocks.query.mockReturnValue({ data: revisions });
    await render(<DocumentDiffModal issueId="issue-raw" documentKey="custom-key" latestRevisionNumber={3} open onOpenChange={vi.fn()} />);
    const [left, right] = Array.from(document.querySelectorAll("select"));
    await act(async () => { left.value = "revision-1"; left.dispatchEvent(new Event("change", { bubbles: true })); });
    await locale("en");
    expect(left.value).toBe("revision-1"); expect(right.value).toBe("revision-3");
    expect(document.body.textContent).toContain("Diff — custom-key");
    await locale("ru");
    expect(document.querySelector("select")).toBe(left);
    expect(document.body.textContent).toContain("Original line 1");
    expect(document.body.textContent).toContain("Original line 3");
    expect(left.selectedOptions[0].textContent).toContain("версия 1");
  });

  it("keeps output URLs, media callbacks, and document fold callbacks unchanged", async () => {
    const item = { id: "output-raw", createdAt: "2026-01-01T00:00:00Z", isPrimary: true, degraded: false, metadata: { contentType: "image/png", byteSize: 1024, originalFilename: "Original.png", contentPath: "/api/raw/content", openPath: "/api/raw/open", downloadPath: "/api/raw/download" } } as IssueOutputItem;
    const media = vi.fn(), fold = vi.fn();
    await render(<><OutputPrimaryCard item={item} onMediaClick={media} /><DocumentFrameHeader documentKey="raw-document" documentLabel="Original title" folded={false} onToggleFolded={fold} /></>);
    const download = host.querySelector('a[href="/api/raw/download"]')!;
    const foldButton = host.querySelector('[aria-label="Свернуть документ raw-document"]')!;
    await locale("en"); await locale("ru");
    expect(host.contains(download)).toBe(true);
    expect(download.getAttribute("aria-label")).toBe("Скачать «Original.png»");
    await click(button("Просмотреть"));
    await click(foldButton);
    expect(media).toHaveBeenCalledWith(item);
    expect(fold).toHaveBeenCalledOnce();
    expect(host.querySelector("img")?.getAttribute("src")).toBe("/api/raw/content");
  });
});
