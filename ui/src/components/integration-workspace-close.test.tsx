// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ExecutionWorkspaceCloseReadiness } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { ExecutionWorkspaceCloseDialog } from "./ExecutionWorkspaceCloseDialog";

const api = vi.hoisted(() => ({ getCloseReadiness: vi.fn(), update: vi.fn() }));
vi.mock("../api/execution-workspaces", () => ({ executionWorkspacesApi: api }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("./ui/dialog", () => ({
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h1>{children}</h1>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <footer>{children}</footer>,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | undefined;
const container = document.createElement("div");
const actions = [
  { kind: "cleanup_command", label: "Run workspace cleanup command", description: "Workspace-specific cleanup runs before teardown.", command: "echo workspace", presentation: { variant: "workspace_cleanup" } },
  { kind: "cleanup_command", label: "Run project workspace cleanup command", description: "Project workspace cleanup runs before execution workspace teardown.", command: "echo project", presentation: { variant: "project_workspace_cleanup" } },
  { kind: "remove_provider_workspace", label: "Remove provider workspace", description: "The storage plugin will verify remote recovery and remove the workspace.", command: null, presentation: { variant: "plugin_storage_removal" } },
  { kind: "remove_provider_workspace", label: "Release remote workspace compute", description: "Release the sandbox and keep the saved workspace files.", command: null, presentation: { variant: "remote_compute_release" } },
];
function readiness(extra: Record<string, unknown> = {}): ExecutionWorkspaceCloseReadiness {
  return { workspaceId: "10000000-0000-4000-8000-000000000001", deliveryState: "unknown", state: "ready", blockingReasons: [], warnings: [], linkedIssues: [], plannedActions: actions, isDestructiveCloseAllowed: true, isSharedWorkspace: false, isProjectPrimaryWorkspace: false, git: null, runtimeServices: [], ...extra } as ExecutionWorkspaceCloseReadiness;
}
async function mount(value: ExecutionWorkspaceCloseReadiness, status: "idle" | "archived" = "idle") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  api.getCloseReadiness.mockResolvedValue(value);
  root = createRoot(container);
  await act(async () => { root!.render(<QueryClientProvider client={client}><ExecutionWorkspaceCloseDialog workspaceId={value.workspaceId} workspaceName="RAW workspace" currentStatus={status} open onOpenChange={vi.fn()} /></QueryClientProvider>); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  return container.querySelector("footer button:last-child") as HTMLButtonElement;
}
const reasonCases = [
  ["no_local_path", {}, "Workspace has no local path, so Paperclip cannot inspect git status before close.", "工作区没有本地路径，因此 Paperclip 无法在关闭前检查 Git 状态。"],
  ["path_missing", { path: '/RAW/<x>' }, 'Workspace path "/RAW/<x>" does not exist, so Paperclip cannot inspect git status before close.', '工作区路径“/RAW/<x>”不存在，因此 Paperclip 无法在关闭前检查 Git 状态。'],
  ["git_inspection_failed", { path: "/RAW", error: "RAW error <x>" }, 'Could not inspect git status for "/RAW": RAW error <x>', '无法检查“/RAW”的 Git 状态：RAW error <x>'],
  ["git_status_failed", { path: "/RAW", error: "RAW error" }, 'Could not read git working tree status for "/RAW": RAW error', '无法读取“/RAW”的 Git 工作树状态：RAW error'],
  ["git_comparison_failed", { baseRef: "RAW/main", error: "RAW error" }, "Could not compare this workspace against RAW/main: RAW error", "无法将此工作区与 RAW/main 比较：RAW error"],
  ["storage_inspection_unavailable", {}, "Workspace storage inspection is unavailable; data was retained.", "无法检查工作区存储；数据已保留。"],
  ["remote_unsaved", {}, "The workspace still has unsaved work or an unfinished writer.", "工作区仍有未保存的工作，或写入操作尚未完成。"],
  ["remote_saved_unavailable", {}, "The saved workspace is unavailable. Its remote files were retained.", "已保存的工作区不可用。其远程文件已保留。"],
  ["remote_save_incomplete", {}, "The remote workspace save is incomplete.", "远程工作区尚未保存完成。"],
  ["git_status_unverified", {}, "Paperclip could not verify the workspace git status. Retry before destructive cleanup.", "Paperclip 无法验证工作区的 Git 状态。请在执行破坏性清理前重试。"],
  ["shared_session_only", {}, "This shared workspace session points at project workspace infrastructure. Archiving it only removes the session record.", "此共享工作区会话使用项目工作区基础设施。归档只会移除会话记录。"],
  ["remote_custom_cleanup_unsupported", {}, "Remote workspace close does not support custom cleanup or teardown commands.", "关闭远程工作区不支持自定义清理或拆除命令。"],
  ["keep_project_workspace", { path: "/RAW" }, 'Paperclip will archive this workspace but keep "/RAW" because it contains the project workspace.', 'Paperclip 将归档此工作区，但会保留“/RAW”，因为该路径包含项目工作区。'],
] as const;
it("localizes only indexed producer reason codes, preserving English, raw collisions and unknown codes", async () => {
  const warnings: string[] = reasonCases.map(row => row[2]);
  const metadata: Record<number, unknown> = Object.fromEntries(reasonCases.map(([code, params], index) => [index, { code, params }]));
  warnings.push(reasonCases[0][2], "unknown provider /RAW diagnostic", "Unknown code diagnostic" as never);
  metadata[warnings.length - 1] = { code: "future_reason", params: { count: 2 } };
  const value = readiness({ warnings, blockingReasons: [reasonCases[9][2], reasonCases[9][2]], presentation: { warnings: metadata, blockingReasons: { 0: { code: "git_status_unverified" } } }, state: "blocked" });
  const original = JSON.stringify(value);
  await i18n.changeLanguage("en");
  const confirm = await mount(value);
  const rows = () => Array.from(container.querySelectorAll("ul li"), li => li.textContent);
  expect(rows()).toEqual([...value.blockingReasons, ...warnings]);
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(rows()).toEqual([reasonCases[9][3], reasonCases[9][2], ...reasonCases.map(row => row[3]), ...warnings.slice(reasonCases.length)]);
  expect(confirm.disabled).toBe(true);
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(rows()).toEqual([...value.blockingReasons, ...warnings]);
  expect(JSON.stringify(value)).toBe(original);
  expect(api.update).not.toHaveBeenCalled();
});
for (const count of [0, 1, 2]) it(`retains reason counts ${count}, raw base refs and raw fallback for old servers`, async () => {
  await i18n.changeLanguage("zh-CN");
  const codes = ["linked_open_issues", "shared_linked_open_issues", "stop_runtime_services", "dirty_tracked_files", "untracked_files", "ahead_of_base", "behind_base"];
  const value = readiness({ warnings: codes.map(code => `RAW ${code}`), presentation: { warnings: Object.fromEntries(codes.map((code, index) => [index, { code, params: { count, baseRef: "RAW/ref" } }])), blockingReasons: {} }, plannedActions: actions.map(({ presentation, ...raw }) => raw) });
  const original = JSON.stringify(value);
  await mount(value);
  const text = container.textContent;
  for (const copy of [`此工作区仍关联着 ${count} 个未关闭任务。`, `关闭此工作区将停止 ${count} 个已关联的运行时服务。`, `工作区有 ${count} 个已修改的已跟踪文件。`, `工作区有 ${count} 个未跟踪文件。`, `此工作区比 RAW/ref 超前 ${count} 个提交，且尚未合并。`, `此工作区比 RAW/ref 落后 ${count} 个提交。`]) expect(text).toContain(copy);
  expect(text).toContain("归档将解除此共享工作区会话与这些任务的关联，但会保留底层项目工作区供继续使用。");
  for (const action of actions) expect(text).toContain(action.description);
  expect(JSON.stringify(value)).toBe(original);
  expect(api.update).not.toHaveBeenCalled();
});
it("keeps the archived confirmation guard independent of translated presentation", async () => {
  await i18n.changeLanguage("zh-CN");
  expect((await mount(readiness(), "archived")).disabled).toBe(true);
  expect(api.update).not.toHaveBeenCalled();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.replaceChildren();
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
});
it("distinguishes all four producer variants, switches mounted en↔zh and keeps commands/raw response intact without mutations", async () => {
  await i18n.changeLanguage("en");
  const value = readiness();
  const original = JSON.stringify(value);
  const confirm = await mount(value);
  for (const action of actions) { expect(container.textContent).toContain(action.label); expect(container.textContent).toContain(action.description); }
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  for (const copy of ["运行工作区清理命令", "运行项目工作区清理命令", "移除提供方工作区", "释放远程工作区计算资源", "工作区专用清理命令在拆除前运行。", "项目工作区清理命令在执行工作区拆除前运行。", "存储插件将验证远程恢复能力并移除工作区。", "释放沙箱并保留已保存的工作区文件。"]) expect(container.textContent).toContain(copy);
  expect(Array.from(container.querySelectorAll("pre"), node => node.textContent)).toEqual(["echo workspace", "echo project"]);
  expect(confirm.disabled).toBe(false);
  await act(async () => { await i18n.changeLanguage("en"); });
  for (const action of actions) { expect(container.textContent).toContain(action.label); expect(container.textContent).toContain(action.description); }
  expect(JSON.stringify(value)).toBe(original);
  expect(api.update).not.toHaveBeenCalled();
  expect(api.getCloseReadiness).toHaveBeenCalledTimes(1);
});
