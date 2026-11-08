// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import { projectsApi } from "../api/projects";
import { ProjectProperties } from "./ProjectProperties";
import { TooltipProvider } from "./ui/tooltip";

vi.mock("../api/projects", () => ({ projectsApi: { createWorkspace: vi.fn(), removeWorkspace: vi.fn().mockResolvedValue(undefined), updateWorkspace: vi.fn().mockResolvedValue({}) } }));
vi.mock("../api/secrets", () => ({ secretsApi: { list: vi.fn().mockResolvedValue([]), listUserSecretDefinitions: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/environments", () => ({ environmentsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn().mockResolvedValue({ enableManagedSandboxOnly: false }) } }));
vi.mock("../api/auth", () => ({ authApi: { getSession: vi.fn().mockResolvedValue(null) } }));
vi.mock("../api/access", () => ({ accessApi: { getCurrentBoardAccess: vi.fn().mockResolvedValue({ source: "local_implicit" }) } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", companies: [] }) }));
vi.mock("./ProjectRepositories", () => ({ ProjectRepositories: () => null }));
vi.mock("./ProjectGitAuthorization", () => ({ ProjectGitAuthorization: () => null }));
vi.mock("./ProjectAccessMembers", () => ({ ProjectAccessMembers: () => null }));
vi.mock("./environment-variables-editor", () => ({ EnvironmentVariablesEditor: () => null }));
vi.mock("./InlineEditor", () => ({ InlineEditor: () => null }));
vi.mock("./PathInstructionsModal", () => ({ ChoosePathButton: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});
function project(repoUrl: string | null): Project {
  const workspace = { id: "workspace-1", cwd: "/unchanged/disk/folder", repoUrl, isPrimary: true };
  return { id: "project-1", name: "Unchanged", status: "in_progress", goals: [], goalIds: [], env: null,
    codebase: { workspaceId: workspace.id, localFolder: workspace.cwd, effectiveLocalFolder: workspace.cwd, repoUrl },
    primaryWorkspace: workspace, workspaces: [workspace], executionWorkspacePolicy: null } as unknown as Project;
}
async function render(repoUrl: string | null, managedOnly = false) {
  client.setQueryData(queryKeys.instance.experimentalSettings, { enableManagedSandboxOnly: managedOnly });
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider>
    <ProjectProperties project={project(repoUrl)} />
  </TooltipProvider></QueryClientProvider>));
}
function clearButton() {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("task-components:clearLocalFolder_845edc73")}"]`);
}
describe("local-folder informed confirmation", () => {
  it.each([
    { repo: "https://example.test/repo", en: "Clear local folder from this workspace?", zh: "清除此工作区的本地文件夹设置？" },
    { repo: null, en: "Delete this workspace local folder?", zh: "移除此工作区的本地文件夹设置？" },
  ])("switches mounted copy and cancels without mutation ($en)", async ({ repo, en, zh }) => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await render(repo);
    expect(clearButton()).not.toBeNull();
    await act(async () => clearButton()!.click());
    expect(confirm).toHaveBeenLastCalledWith(en);
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    await act(async () => clearButton()!.click());
    expect(confirm).toHaveBeenLastCalledWith(zh);
    expect(projectsApi.createWorkspace).not.toHaveBeenCalled();
    expect(projectsApi.updateWorkspace).not.toHaveBeenCalled();
    expect(projectsApi.removeWorkspace).not.toHaveBeenCalled();
  });
  it.each(["en", "zh-CN"])("only clears cwd or removes the workspace record on acceptance (%s)", async locale => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await i18n.changeLanguage(locale);
    await render("https://example.test/repo");
    await act(async () => clearButton()!.click());
    expect(projectsApi.updateWorkspace).toHaveBeenCalledExactlyOnceWith("project-1", "workspace-1", { cwd: null, sourceType: "git_repo", isPrimary: true });
    expect(projectsApi.removeWorkspace).not.toHaveBeenCalled();
    await render(null);
    await act(async () => clearButton()!.click());
    expect(projectsApi.removeWorkspace).toHaveBeenCalledExactlyOnceWith("project-1", "workspace-1");
    expect(projectsApi.createWorkspace).not.toHaveBeenCalled();
  });
  it("retains the managed-sandbox host-path guard", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await render(null, true);
    expect(clearButton()).toBeNull();
    expect(container.textContent).not.toContain("/unchanged/disk/folder");
    expect(confirm).not.toHaveBeenCalled();
    expect(projectsApi.updateWorkspace).not.toHaveBeenCalled();
    expect(projectsApi.removeWorkspace).not.toHaveBeenCalled();
  });
});
