// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUE_WRITE_DENIAL_CODES, describeIssueWriteDenial, type HeartbeatRun, type Issue, type IssueDocument, type IssueProductivityReview } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { ToastProvider } from "@/context/ToastContext";
import { IssueContinuationHandoff } from "./IssueContinuationHandoff";
import { ProductivityReviewBadge } from "./ProductivityReviewBadge";
import { StalledReviewActions } from "./StalledReviewActions";
import { IssueMonitorBanner, IssueMonitorComposerStrip, buildMonitorSurfaceCopy, buildMonitorSurfaceCopyDisplay } from "./IssueMonitorBanner";
import { deriveMonitorState } from "@/lib/issue-monitor";
import { IssueWriteDenialNotice, describeIssueWriteDenialDisplay } from "./IssueWriteDenialNotice";
import { IssueAssignedBacklogNotice } from "./IssueAssignedBacklogNotice";
import { IssueSiblingNavigation } from "./IssueSiblingNavigation";
import { IssueReferenceActivitySummary } from "./IssueReferenceActivitySummary";
import { SourceResolvedFoldBadge } from "./SourceResolvedFoldBadge";
import { RunWorkspaceRecoverySurface } from "./RunWorkspaceRecoverySurface";

const mocks = vi.hoisted(() => ({ query: vi.fn(), decide: vi.fn(), copy: vi.fn(), create: vi.fn(), reconcile: vi.fn(), resolve: vi.fn(), navigate: vi.fn() }));
vi.mock("@tanstack/react-query", async () => ({
  ...await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query"),
  useQuery: (options: unknown) => mocks.query(options),
}));
vi.mock("@/api/issues", () => ({ issuesApi: { decideStalledReview: (...args: unknown[]) => mocks.decide(...args), create: (...args: unknown[]) => mocks.create(...args), resolveRecoveryAction: (...args: unknown[]) => mocks.resolve(...args) } }));
vi.mock("@/api/execution-workspaces", () => ({ executionWorkspacesApi: { reconcile: (...args: unknown[]) => mocks.reconcile(...args) } }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: (...args: unknown[]) => mocks.copy(...args) }));
vi.mock("@/lib/router", () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ to, children, state, issuePrefetch: _p, issueQuicklookSide: _s, issueQuicklookAlign: _a, ...props }: ComponentProps<"a"> & { to: string; state?: unknown; issuePrefetch?: unknown; issueQuicklookSide?: unknown; issueQuicklookAlign?: unknown }) =>
    <a href={to} data-link-state={JSON.stringify(state)} {...props}>{children}</a>,
}));
vi.mock("./MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: ReactNode }) => <div data-raw-markdown>{children}</div> }));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./IssueRecoveryActionCard", () => ({
  IssueRecoveryActionCard: ({ onReissueIsolated, onBreakGlassOverride, onResolve }: {
    onReissueIsolated: (request: { baseRef: string; expectedBranch: string }) => void;
    onBreakGlassOverride: (reason: string) => void;
    onResolve: (outcome: string) => void;
  }) => <div>
    <button data-testid="raw-reissue" onClick={() => onReissueIsolated({ baseRef: "raw/base", expectedBranch: "raw/expected" })}>raw</button>
    <button data-testid="raw-override" onClick={() => onBreakGlassOverride("Keep original **reason**")}>raw</button>
    <button data-testid="raw-resolve" onClick={() => onResolve("false_positive_in_review")}>raw</button>
  </div>,
}));

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
async function locale(language: "ru" | "en") { await act(async () => { await i18n.changeLanguage(language); }); }
async function render(node: ReactNode) { await act(async () => root.render(<QueryClientProvider client={client}><ToastProvider>{node}</ToastProvider></QueryClientProvider>)); }
async function click(element: Element | null | undefined) { expect(element).toBeTruthy(); await act(async () => { (element as HTMLElement).click(); }); }
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.query.mockReturnValue({ data: undefined });
  mocks.decide.mockResolvedValue({}); mocks.create.mockResolvedValue({ identifier: "RAW-NEW" }); mocks.reconcile.mockResolvedValue({}); mocks.resolve.mockResolvedValue({});
  await locale("ru");
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); client.clear(); vi.useRealTimers(); vi.restoreAllMocks(); await locale("en");
});

describe("issue chrome runtime localization", () => {
  it("preserves expanded handoff and copied state while copying the original Markdown", async () => {
    const document = { id: "document-raw", title: null, body: "# Original\n\nKeep **Markdown**", latestRevisionNumber: 21, updatedAt: new Date("2026-01-01T00:00:00Z") } as IssueDocument;
    await render(<IssueContinuationHandoff document={document} />);
    const toggle = host.querySelector('[aria-expanded="false"]')!;
    await click(toggle);
    const body = host.querySelector("[data-raw-markdown]")!;
    await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Копировать"));
    expect(mocks.copy).toHaveBeenCalledWith(document.body);
    await locale("en");
    expect(host.textContent).toContain("Copied");
    expect(host.textContent).toContain("revision 21");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await locale("ru");
    expect(host.contains(body)).toBe(true);
    expect(body.textContent).toBe(document.body);
    expect(host.textContent).toContain("Скопировано");
  });

  it("translates productivity triggers and counts without changing review links or unknown statuses", async () => {
    const review = { trigger: "no_comment_streak", reviewIssueId: "issue-raw", reviewIdentifier: "RAW-21", status: "custom_status", noCommentStreak: 21 } as unknown as IssueProductivityReview;
    await render(<ProductivityReviewBadge review={review} />);
    const link = host.querySelector("a")!;
    expect(link.getAttribute("aria-label")).toContain("Серия запусков без комментариев");
    expect(host.textContent).toContain("21 запуск");
    expect(host.textContent).toContain("custom status");
    await locale("en");
    expect(link.getAttribute("aria-label")).toContain("No-comment streak");
    await locale("ru");
    expect(host.querySelector("a")).toBe(link);
    expect(link.getAttribute("href")).toBe("/issues/RAW-21");
    for (const [count, label] of [[1, "1 запуск"], [2, "2 запуска"], [5, "5 запусков"], [21, "21 запуск"]] as const) {
      expect(i18n.t("localizationIssueChrome.runs", { count })).toBe(label);
    }
  });

  it("retains review note, required-note constraint and raw decision payload during pending work", async () => {
    const resolved = vi.fn();
    let finish: (value: unknown) => void = () => {};
    mocks.decide.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(<StalledReviewActions issueId="issue-raw" companyId="company-raw" onResolved={resolved} />);
    const note = host.querySelector("textarea")!;
    const request = host.querySelector<HTMLButtonElement>('[data-testid="stalled-review-request-changes"]')!;
    expect(request.disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "  Keep original **note**  ");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(request.disabled).toBe(false);
    await locale("en");
    expect(note.value).toBe("  Keep original **note**  ");
    expect(note.placeholder).toContain("required to request changes");
    await locale("ru");
    expect(note.placeholder).toContain("обязателен при запросе изменений");
    await click(request);
    await locale("en");
    expect(request.disabled).toBe(true);
    await locale("ru");
    expect(host.querySelector("textarea")).toBe(note);
    await act(async () => { finish({}); }); await flush();
    expect(mocks.decide).toHaveBeenCalledWith("issue-raw", { action: "request_changes", note: "Keep original **note**" });
    expect(resolved).toHaveBeenCalledWith("request_changes");
    expect(note.value).toBe("");
  });

  it("keeps raw monitor derivation and tones while reacting to locale without a timer tick", async () => {
    vi.useFakeTimers(); const now = new Date("2026-01-01T00:00:00Z"); vi.setSystemTime(now);
    const issue = { executionState: { monitor: { status: "scheduled", nextCheckAt: "2026-01-01T02:00:00Z", attemptCount: 2, serviceName: "raw/service" } }, scheduledRetry: null } as unknown as Issue;
    const derived = deriveMonitorState(issue, now), raw = buildMonitorSurfaceCopy(derived, now);
    const check = vi.fn();
    await render(<><IssueMonitorBanner issue={issue} onCheckNow={check} /><IssueMonitorComposerStrip issue={issue} /></>);
    const button = host.querySelector("button")!;
    expect(host.textContent).toContain("Ожидание проверки");
    expect(host.textContent).toContain("raw/service");
    await locale("en");
    expect(host.textContent).toContain("Waiting on monitor — resumes in 2h");
    await locale("ru");
    expect(host.querySelector("button")).toBe(button);
    await click(button);
    expect(check).toHaveBeenCalledOnce();
    expect(buildMonitorSurfaceCopy(derived, now)).toEqual(raw);
    expect(buildMonitorSurfaceCopyDisplay(derived, now)?.tone).toBe(raw?.tone);
    for (const [state, key] of [["due-now", "monitorWaitDue"], ["overdue", "monitorWaitOverdue"]] as const) {
      expect(buildMonitorSurfaceCopyDisplay({ ...derived, state, nextCheckAt: now }, now)?.bannerTitle).toContain(i18n.t("localizationIssueChrome." + key, { eta: "" }).trim());
    }
  });

  it("preserves all denial codes, HTTP status and boundary tones with full translated constraints", async () => {
    const context = { actorLabel: "Raw Actor", responsibleUserName: "Raw User", assigneeLabel: "Raw Assignee", issueIdentifier: "RAW-21", cap: 20, count: 21 };
    const original = ISSUE_WRITE_DENIAL_CODES.map((code) => describeIssueWriteDenial(code, context));
    await render(<>{ISSUE_WRITE_DENIAL_CODES.map((code) => <IssueWriteDenialNotice key={code} code={code} context={context} />)}</>);
    const notices = Array.from(host.querySelectorAll("[data-denial-code]"));
    expect(host.textContent).toContain("Кто может выполнить действие:");
    expect(host.textContent).toContain("создайте подзадачу");
    expect(host.textContent).toContain("номер этой попытки — 21");
    expect(host.textContent).toContain("X-Paperclip-Run-Id");
    expect(host.textContent).toContain("$PAPERCLIP_RUN_ID");
    expect(host.textContent).toContain("onBehalfOfUserId");
    await locale("en");
    expect(host.textContent).toContain("Who can act:");
    await locale("ru");
    for (const [index, code] of ISSUE_WRITE_DENIAL_CODES.entries()) {
      const projected = describeIssueWriteDenialDisplay(code, context);
      expect(describeIssueWriteDenial(code, context)).toEqual(original[index]);
      expect(projected.code).toBe(original[index].code);
      expect(projected.status).toBe(original[index].status);
      expect(projected.tone).toBe(original[index].tone);
      expect(host.querySelectorAll("[data-denial-code]")[index]).toBe(notices[index]);
      expect(projected.description).not.toContain("localizationIssueChrome");
    }
  });

  it("retains reference nodes and sibling navigation state when labels change", async () => {
    const issue = { id: "raw-issue", identifier: "RAW-21", title: "Original title", status: "todo" } as Issue;
    const event = { details: { addedReferencedIssues: [issue], removedReferencedIssues: [{ id: "raw-no-id", title: "Unlinked title" }] } };
    await render(<><IssueReferenceActivitySummary event={event} /><IssueSiblingNavigation navigation={{ previous: issue, next: null, currentIndex: 1, totalCount: 2 }} linkState={{ from: "/raw/from", label: "Original label" }} /></>);
    const links = Array.from(host.querySelectorAll("a"));
    const state = links[1].getAttribute("data-link-state");
    await locale("en"); await locale("ru");
    expect(Array.from(host.querySelectorAll("a"))).toEqual(links);
    expect(links[0].getAttribute("aria-label")).toBe("Задача RAW-21: Original title");
    expect(links[1].getAttribute("data-link-state")).toBe(state);
    expect(links[1].getAttribute("aria-label")).toContain("Предыдущая подзадача: RAW-21");
    expect(host.textContent).toContain("Original title");
    expect(host.querySelector('span[aria-label="Задача: Unlinked title"]')).toBeTruthy();
  });

  it("keeps backlog semantics, resume callback and custom fold titles", async () => {
    const resume = vi.fn();
    await render(<><IssueAssignedBacklogNotice issueStatus="backlog" assigneeAgent={null} assigneeUserId="user-raw" onResume={resume} /><SourceResolvedFoldBadge /><SourceResolvedFoldBadge title="Original custom title" /></>);
    const notice = host.querySelector('[data-issue-status="backlog"]')!, trigger = host.querySelector("button")!;
    expect(host.textContent).toContain("не получит запрос на работу");
    await locale("en"); await locale("ru");
    expect(host.contains(notice)).toBe(true);
    await click(trigger);
    expect(resume).toHaveBeenCalledOnce();
    expect(host.querySelector('[title="Original custom title"]')).toBeTruthy();
    expect(host.textContent).toContain("Исходная задача решена");
    await render(<IssueAssignedBacklogNotice issueStatus="todo" assigneeAgent={null} assigneeUserId="user-raw" />);
    expect(host.querySelector("[data-issue-status]")).toBeNull();
  });

  it("preserves isolated reissue templates, workspace modes and decision IDs", async () => {
    const issue = { id: "issue-raw", companyId: "company-raw", identifier: "RAW-21", title: "Original title", description: "# Original body", priority: "medium", executionWorkspaceId: "ws-raw", activeRecoveryAction: { id: "action-raw", kind: "workspace_validation", previousOwnerAgentId: "agent-raw" } };
    mocks.query.mockImplementation(({ queryKey }: { queryKey: string[] }) => ({ data: queryKey.includes("current-board-access") ? { source: "local_implicit", companyIds: ["company-raw"] } : issue }));
    const run = { id: "run-raw", companyId: "company-raw", status: "failed", errorCode: "workspace_validation_failed", contextSnapshot: { issueId: "issue-raw" } } as unknown as HeartbeatRun;
    await render(<RunWorkspaceRecoverySurface run={run} />);
    const link = host.querySelector("a")!;
    await locale("en"); await locale("ru");
    expect(host.textContent).toContain("Восстановление рабочей области");
    expect(host.contains(link)).toBe(true);
    await click(host.querySelector('[data-testid="raw-reissue"]')); await flush();
    expect(mocks.create).toHaveBeenCalledWith("company-raw", expect.objectContaining({
      title: "Re-issue (isolated): Original title",
      description: "Re-issued from RAW-21 on an isolated git worktree after a workspace branch divergence.\n\n- Base ref (live branch): `raw/base`\n- Recorded branch: `raw/expected`\n\n---\n\n# Original body",
      assigneeAgentId: "agent-raw",
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree", baseRef: "raw/base" } },
    }));
    await click(host.querySelector('[data-testid="raw-override"]')); await flush();
    expect(mocks.reconcile).toHaveBeenCalledWith("ws-raw", { mode: "override", reason: "Keep original **reason**" });
    await click(host.querySelector('[data-testid="raw-resolve"]')); await flush();
    expect(mocks.resolve).toHaveBeenCalledWith("issue-raw", { actionId: "action-raw", outcome: "false_positive", sourceIssueStatus: "in_review" });
    expect(run.errorCode).toBe("workspace_validation_failed");
  });
});
