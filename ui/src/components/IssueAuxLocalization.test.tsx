// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AcceptedPlanDecompositionSummary, DocumentAnnotationThreadWithComments, IssueAttachment } from "@paperclipai/shared";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { OutputFeedbackButtons } from "./OutputFeedbackButtons";
import { DocumentAnnotationPanel, type AnnotationPanelProps } from "./DocumentAnnotationPanel";
import { IssueAttachmentsSection } from "./IssueAttachmentsSection";
import { IssueWorkspaceCard } from "./IssueWorkspaceCard";
import { IssuePlanDecompositionsSection } from "./IssuePlanDecompositionsSection";
import { ActionCard, BindingsTable } from "./actions/ActionCard";
import { TaskDetailReferencesPanel, TaskDetailSubtasksPanel } from "./task-detail/TaskDetailRelationsPanel";
import { createIssueDetailLocationState, createIssueDetailPath, readIssueDetailBreadcrumb, readIssueDetailBreadcrumbDisplay, rememberIssueDetailLocationState } from "@/lib/issueDetailBreadcrumb";
import { annotationMutationErrorDisplay } from "@/hooks/useDocumentAnnotationMutations";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  create: vi.fn(),
  reply: vi.fn(),
  status: vi.fn(),
}));
vi.mock("@tanstack/react-query", async () => ({
  ...await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query"),
  useQuery: (options: unknown) => mocks.query(options),
}));
vi.mock("@/api/document-annotations", () => ({ documentAnnotationsApi: {
  createForTarget: (...args: unknown[]) => mocks.create(...args),
  addCommentForTarget: (...args: unknown[]) => mocks.reply(...args),
  updateStatusForTarget: (...args: unknown[]) => mocks.status(...args),
} }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-raw" }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, state: _state, ...rest }: ComponentProps<"a"> & { to: string; state?: unknown }) => <a href={to} {...rest}>{children}</a>,
}));
vi.mock("./MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("./IssueRow", () => ({ IssueRow: ({ issue }: { issue: { title: string } }) => <div>{issue.title}</div> }));
vi.mock("./EnforcementBanner", () => ({ EnforcementBanner: ({ title, body }: { title: string; body: string }) => <div>{title}{body}</div> }));

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
async function render(node: ReactNode) {
  await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
}
async function locale(value: "ru" | "en") { await act(async () => { await i18n.changeLanguage(value); }); }
async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => { (element as HTMLElement).click(); });
}
function button(label: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
}
async function type(input: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mocks.query.mockReset().mockImplementation(() => ({ data: undefined }));
  mocks.create.mockReset();
  mocks.reply.mockReset().mockResolvedValue({});
  mocks.status.mockReset().mockResolvedValue({});
  await locale("ru");
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  window.sessionStorage.clear();
  await locale("en");
});

const annotationThread = {
  id: "thread-raw", documentKey: "plan", status: "open", anchorState: "active",
  selectedText: "**Original selection**", normalizedStart: 0, markdownStart: 0,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  comments: [{ id: "comment-raw", body: "Original **Markdown**", authorType: "agent", authorAgentId: null, authorUserId: null, createdAt: new Date("2026-01-01T00:00:00Z") }],
} as DocumentAnnotationThreadWithComments;

describe("auxiliary issue localization", () => {
  it("retains feedback consent and drafts through ru → en → ru, and submits raw votes", async () => {
    const onVote = vi.fn().mockResolvedValue(undefined);
    await render(<OutputFeedbackButtons onVote={onVote} termsUrl="https://paperclip.test/terms" />);
    await click(button("Полезно"));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("в любом случае сохраняется локально");
    await locale("en");
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog.textContent).toContain("This vote is always saved locally.");
    await locale("ru");
    await click(button("Не разрешать", dialog));
    expect(onVote).toHaveBeenLastCalledWith("up", undefined);
    await click(button("Нужна доработка"));
    await click(button("Всегда разрешать", document.querySelector('[role="dialog"]')!));
    expect(onVote).toHaveBeenLastCalledWith("down", { allowSharing: true });
    const note = host.querySelector("textarea")!;
    await type(note, "Keep **my note**, /raw/path");
    await locale("en");
    expect(host.querySelector("textarea")).toBe(note);
    expect(note.value).toBe("Keep **my note**, /raw/path");
    await locale("ru");
    await click(button("Сохранить заметку"));
    expect(onVote).toHaveBeenLastCalledWith("down", { allowSharing: true, reason: "Keep **my note**, /raw/path" });
  });

  it("keeps annotation anchors, Markdown drafts and status payloads unchanged", async () => {
    mocks.create.mockResolvedValue(annotationThread);
    const selector = { position: { normalizedStart: 0, markdownStart: 0 } };
    const props = {
      open: true, onOpenChange: vi.fn(), issueId: "issue-raw", documentKey: "plan",
      documentRevisionNumber: 21, baseRevisionNumber: 21, baseRevisionId: "revision-raw",
      threads: [annotationThread], focusedThreadId: "thread-raw", focusedCommentId: null,
      onFocusThread: vi.fn(), pendingAnchor: { selectedText: "**Original selection**", selector },
      onClearPendingAnchor: vi.fn(),
    } as unknown as AnnotationPanelProps;
    await render(<DocumentAnnotationPanel {...props} />);
    const composer = host.querySelector<HTMLTextAreaElement>('[data-testid="document-annotation-composer"]')!;
    const reply = host.querySelector<HTMLTextAreaElement>('[data-testid="document-annotation-reply-thread-raw"]')!;
    await type(composer, "New **comment** /raw/path");
    await type(reply, "Reply in English");
    await locale("en");
    expect(host.querySelector('[data-testid="document-annotation-composer"]')).toBe(composer);
    expect(reply.value).toBe("Reply in English");
    expect(host.querySelector("aside")?.getAttribute("aria-label")).toBe("Annotations for PLAN, revision 21");
    await locale("ru");
    expect(composer.value).toBe("New **comment** /raw/path");
    expect(host.textContent).toContain("Original **Markdown**");
    await click(button("Ответить"));
    expect(mocks.reply).toHaveBeenLastCalledWith({ kind: "issue", issueId: "issue-raw", documentKey: "plan" }, "thread-raw", { body: "Reply in English" });
    await click(button("Отметить решённым"));
    expect(mocks.status).toHaveBeenLastCalledWith({ kind: "issue", issueId: "issue-raw", documentKey: "plan" }, "thread-raw", "resolved");
    await click(button("Прокомментировать"));
    expect(mocks.create).toHaveBeenLastCalledWith({ kind: "issue", issueId: "issue-raw", documentKey: "plan" }, {
      baseRevisionId: "revision-raw", baseRevisionNumber: 21, selector, body: "New **comment** /raw/path",
    });
  });

  it("retains an attachment deletion confirmation and exact paths across locale changes", async () => {
    const attachment = { id: "attachment-raw", contentType: "application/pdf", originalFilename: "Report EN.pdf", contentPath: "/api/attachments/raw/content", byteSize: 1024 } as IssueAttachment;
    const onDelete = vi.fn();
    await render(<IssueAttachmentsSection attachments={[attachment]} onDelete={onDelete} onImageClick={vi.fn()} />);
    const open = host.querySelector('a[aria-label="Открыть «Report EN.pdf»"]')!;
    expect(open.getAttribute("href")).toBe("/api/attachments/raw/content");
    await click(host.querySelector('button[title="Удалить вложение"]'));
    await locale("en");
    expect(host.contains(open)).toBe(true);
    expect(host.textContent).toContain("Delete this attachment? This cannot be undone.");
    await locale("ru");
    expect(host.textContent).toContain("Это действие нельзя отменить.");
    await click(button("Удалить"));
    expect(onDelete).toHaveBeenCalledWith("attachment-raw");
  });

  it("preserves a workspace mode draft and submits the same raw mode", async () => {
    mocks.query.mockImplementation((options: { queryKey: unknown[] }) => options.queryKey[0] === "instance"
      ? { data: { enableIsolatedWorkspaces: true, enableManagedSandboxOnly: false } }
      : { data: [] });
    const onUpdate = vi.fn();
    await render(<IssueWorkspaceCard initialEditing issue={{
      companyId: "company-raw", projectId: "project-raw", projectWorkspaceId: null, executionWorkspaceId: null,
      executionWorkspacePreference: "isolated_workspace", executionWorkspaceSettings: null,
    }} project={{ id: "project-raw", executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace" } }} onUpdate={onUpdate} />);
    const select = host.querySelector("select")!;
    await act(async () => { select.value = "shared_workspace"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await locale("en");
    expect(host.querySelector("select")).toBe(select);
    expect(select.value).toBe("shared_workspace");
    await locale("ru");
    expect(select.selectedOptions[0].textContent).toBe("По умолчанию для проекта");
    await click(button("Сохранить"));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ executionWorkspacePreference: "shared_workspace" }));
  });

  it("keeps stale approval disabled, signed hashes and JSON intact, and binding row identity stable", async () => {
    const deny = vi.fn();
    const input = { method: "delete", path: "/raw/path", body: "Original prompt" };
    await render(<><ActionCard variant="stale" agentName="Coder" toolName="raw.action" risk="high"
      input={input} reason="User-supplied reason" policyNumber={7}
      binding={{ application: "Slack", manifestVersion: "2", connection: "https://example.test", catalogSha256: "sha256:new", previousCatalogSha256: "sha256:old", payloadSha256: "sha256:payload" }}
      onDeny={deny} />
      <BindingsTable rows={[{ label: "Custom field", value: "raw" }]} />
    </>);
    const row = host.querySelector("dt")!;
    expect(button("Одобрить")?.disabled).toBe(true);
    expect(host.textContent).toContain("Одобрение недоступно");
    await locale("en");
    expect(host.querySelector("dt")).toBe(row);
    expect(button("Approve")?.disabled).toBe(true);
    await locale("ru");
    expect(host.querySelector("pre")?.textContent).toBe(JSON.stringify(input, null, 2));
    expect(host.querySelector(".line-through")?.textContent).toBe("sha256:old");
    expect(host.textContent).toContain("sha256:payload");
    expect(host.textContent).toContain("Custom field");
    await click(button("Отклонить"));
    expect(deny).toHaveBeenCalledOnce();
  });

  it("uses Russian counts for plan revisions and comments without rewriting child task content", async () => {
    const records = Array.from({ length: 21 }, (_, index) => ({
      id: "plan-" + index, status: "completed", requestedChildCount: 21, childIssueIds: ["child-raw"],
      acceptedPlanRevisionNumber: 21, acceptedPlanRevisionId: "revision-raw",
      childIssues: [{ id: "child-raw", identifier: "RAW-21", title: "Keep child title" }],
    })) as unknown as AcceptedPlanDecompositionSummary[];
    mocks.query.mockImplementation(() => ({ data: records }));
    await render(<IssuePlanDecompositionsSection issueId="issue-raw" issueIdentifier="RAW-1" />);
    expect(host.textContent).toContain("21 принятая версия плана");
    expect(host.textContent).toContain("Создано подзадач: 1 из 21");
    const child = host.querySelector('a[href="/issues/RAW-21"]')!;
    await locale("en");
    expect(host.textContent).toContain("21 accepted plan revisions");
    expect(host.contains(child)).toBe(true);
    await locale("ru");
    expect(child.textContent).toContain("Keep child title");
    for (const [count, expected] of [[1, "1 комментарий"], [2, "2 комментария"], [5, "5 комментариев"], [21, "21 комментарий"]] as const) {
      expect(i18n.t("localizationIssueAux.comments", { count })).toBe(expected);
    }
  });

  it("localizes relation labels and breadcrumb display while preserving storage, routes and unknown errors", async () => {
    const add = vi.fn();
    await render(<><TaskDetailSubtasksPanel items={[]} onAddSubtask={add} /><TaskDetailReferencesPanel referenced={[]} mentionedIn={[]} /></>);
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0");
    const state = createIssueDetailLocationState("Inbox", "/RAW/inbox/unread", "inbox");
    rememberIssueDetailLocationState("RAW-1", state);
    const raw = window.sessionStorage.getItem("paperclip:issue-detail-breadcrumb:RAW-1");
    expect(readIssueDetailBreadcrumbDisplay("RAW-1", null)?.label).toBe("Входящие");
    expect(readIssueDetailBreadcrumb("RAW-1", null)?.label).toBe("Inbox");
    await locale("en");
    expect(host.textContent).toContain("No subtasks yet.");
    expect(readIssueDetailBreadcrumbDisplay("RAW-1", null)?.label).toBe("Inbox");
    await locale("ru");
    await click(button("Добавить подзадачу"));
    expect(add).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem("paperclip:issue-detail-breadcrumb:RAW-1")).toBe(raw);
    expect(createIssueDetailPath("RAW-1")).toBe("/issues/RAW-1");
    expect(readIssueDetailBreadcrumbDisplay(null, createIssueDetailLocationState("Custom list", "/issues", "issues"))?.label).toBe("Custom list");
    expect(annotationMutationErrorDisplay("Failed to add reply.")).toBe("Не удалось добавить ответ.");
    expect(annotationMutationErrorDisplay("Server says raw_problem")).toBe("Server says raw_problem");
  });
});
