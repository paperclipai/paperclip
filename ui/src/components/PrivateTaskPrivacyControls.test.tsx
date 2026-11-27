// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
const api = vi.hoisted(() => ({ getIssue: vi.fn(), getProject: vi.fn(), constraints: vi.fn(), setVisibility: vi.fn(),
  members: vi.fn(), add: vi.fn(), remove: vi.fn(), directory: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { get: api.getIssue, privacyConstraints: api.constraints, setVisibility: api.setVisibility } }));
vi.mock("@/api/projects", () => ({ projectsApi: { get: api.getProject, listAccessMembers: api.members,
  addAccessMember: api.add, removeAccessMember: api.remove } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: api.directory } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: () => Promise.resolve([]) } }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
import { IssuePrivacyActions } from "./IssuePrivacyActions";
import { ProjectAccessMembers } from "./ProjectAccessMembers";
import type { Project } from "@paperclipai/shared";
async function settle() {
  for (let i = 0; i < 8; i++) { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); }
}
const originalScrollIntoView = Element.prototype.scrollIntoView;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollIntoView = () => {};
  vi.resetAllMocks();
  api.directory.mockResolvedValue({ users: [] });
  api.constraints.mockResolvedValue({ publicBlockedBy: null, leavesPersonalProject: false });
  api.members.mockResolvedValue([]);
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { flushSync(() => root.unmount()); client.clear(); document.body.innerHTML = "";
    vi.unstubAllGlobals();
    Element.prototype.scrollIntoView = originalScrollIntoView; });
function render(node: React.ReactNode) { flushSync(() => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)); }
function publicButton() { return [...document.body.querySelectorAll("button")].find(b => b.textContent?.trim() === "Make public")!; }
function actions(scope: { privacyParentIssueId?: string; projectId?: string } = {}) {
  render(<IssuePrivacyActions issue={{ id: "child", visibility: "private", identifier: "PAP-1", ...scope }} companyId="company" canManage closeMenu={() => {}}>{items => <div>{items}</div>}</IssuePrivacyActions>);
}
describe("inherited privacy controls", () => {
  it("blocks a private parent and does not send an impossible visibility change", async () => {
    api.constraints.mockResolvedValue({ publicBlockedBy: "parent", leavesPersonalProject: false });
    actions({ privacyParentIssueId: "parent" }); await settle();
    expect(publicButton().disabled).toBe(true);
    publicButton().click(); expect(api.setVisibility).not.toHaveBeenCalled();
  });
  it("blocks a non-personal private project but permits leaving a personal project", async () => {
    api.constraints.mockResolvedValue({ publicBlockedBy: "project", leavesPersonalProject: false });
    actions({ projectId: "project" }); await settle(); expect(publicButton().disabled).toBe(true);
    api.constraints.mockResolvedValue({ publicBlockedBy: null, leavesPersonalProject: true });
    await client.invalidateQueries({ queryKey: queryKeys.issues.privacyConstraints("child") }); await settle();
    expect(publicButton().disabled).toBe(false);
  });
  it.each([
    ["parent", { privacyParentIssueId: "private-parent" }],
    ["project", { projectId: "private-project" }],
  ] as const)("refreshes task privacy after moving out of a private %s", async (kind, scope) => {
    api.constraints.mockResolvedValue({ publicBlockedBy: kind, leavesPersonalProject: false });
    actions(scope); await settle();
    expect(publicButton().disabled).toBe(true);
    expect(api.constraints).toHaveBeenCalledTimes(1);
    api.constraints.mockResolvedValue({ publicBlockedBy: null, leavesPersonalProject: false });
    // Same task ID and mounted action menu: only the surrounding scope changes.
    actions(); await settle();
    expect(api.constraints).toHaveBeenCalledTimes(2);
    expect(publicButton().disabled).toBe(false);
  });
  it("checks a parent's private project even when the parent itself is open", async () => {
    api.constraints.mockResolvedValue({ publicBlockedBy: "parent", leavesPersonalProject: false });
    actions({ privacyParentIssueId: "parent" }); await settle(); expect(publicButton().disabled).toBe(true);
  });
  it("permits making a child public after its parent is open", async () => {
    api.constraints.mockResolvedValue({ publicBlockedBy: null, leavesPersonalProject: false });
    actions({ privacyParentIssueId: "parent" }); await settle(); expect(publicButton().disabled).toBe(false);
  });
  it("allows publishing from an unreadable personal project without fetching that project", async () => {
    api.getProject.mockRejectedValue(new Error("404"));
    api.constraints.mockResolvedValue({ publicBlockedBy: null, leavesPersonalProject: true });
    api.setVisibility.mockResolvedValue({});
    actions({ projectId: "protected-project" }); await settle();
    expect(publicButton().disabled).toBe(false);
    expect(api.getProject).not.toHaveBeenCalled();
    flushSync(() => publicButton().click()); await settle();
    expect(document.body.textContent).toContain("leave its personal project");
    const confirm = [...document.body.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent === "Make public")!;
    flushSync(() => (confirm as HTMLButtonElement).click()); await settle();
    expect(api.setVisibility).toHaveBeenCalledWith("child", "open");
  });
  it("explains a protected private parent without offering an impossible retry", async () => {
    api.getIssue.mockRejectedValue(new Error("404"));
    api.constraints.mockResolvedValue({ publicBlockedBy: "parent", leavesPersonalProject: false });
    actions({ privacyParentIssueId: "protected-parent" }); await settle();
    expect(publicButton().disabled).toBe(true);
    expect(api.getIssue).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Retry access check");
  });
  it("keeps unresolved and failed scope checks closed, and retries in place", async () => {
    let reject!: (error: Error) => void;
    api.constraints.mockReturnValue(new Promise((_resolve, rejectFn) => { reject = rejectFn; }));
    actions({ privacyParentIssueId: "parent" }); await settle(); expect(publicButton().disabled).toBe(true);
    reject(new Error("Unavailable")); await settle(); expect(publicButton().disabled).toBe(true);
    api.constraints.mockResolvedValue({ publicBlockedBy: null, leavesPersonalProject: false });
    flushSync(() => [...document.body.querySelectorAll("button")].find(b => b.textContent === "Retry access check")!.click());
    await settle(); expect(publicButton().disabled).toBe(false);
  });
});
it("invalidates cached task audience when project membership is removed", async () => {
  const key = queryKeys.issues.accessGrants("child");
  client.setQueryData(key, [{ subjectId: "member", source: "project" }]);
  api.members.mockResolvedValue([{ id: "m1", subjectType: "user", subjectId: "member", subjectDisplayName: "Morgan" }]);
  api.remove.mockResolvedValue({});
  render(<ProjectAccessMembers project={{ id: "project", companyId: "company" } as Project} canManage />);
  flushSync(() => [...document.body.querySelectorAll("button")].find(b => b.textContent?.includes("Manage access"))!.click());
  await settle();
  flushSync(() => (document.body.querySelector('[aria-label="Remove Morgan"]') as HTMLButtonElement).click());
  await settle();
  expect(api.remove).toHaveBeenCalledWith("project", "m1", "company");
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
});
