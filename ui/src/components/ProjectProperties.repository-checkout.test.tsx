// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectProperties } from "./ProjectProperties";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "../lib/queryKeys";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(() => {
    callback();
  });
}

const noop = vi.hoisted(() => () => undefined);

vi.mock("../api/projects", () => ({ projectsApi: { createWorkspace: vi.fn(), removeWorkspace: vi.fn(), updateWorkspace: vi.fn() } }));
vi.mock("../api/goals", () => ({ goalsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/secrets", () => ({ secretsApi: { list: vi.fn().mockResolvedValue([]), listUserSecretDefinitions: vi.fn().mockResolvedValue([]), create: vi.fn() } }));
vi.mock("../api/environments", () => ({ environmentsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }) } }));
vi.mock("@/api/access", () => ({
  accessApi: {
    getCurrentBoardAccess: vi.fn().mockResolvedValue(null),
    listMembers: vi.fn().mockResolvedValue({
      members: [
        { user: { id: "scott", name: "Scott", email: "scott@example.test" } },
        { user: { id: "riley", name: "Riley", email: "riley@example.test" } },
      ],
    }),
  },
}));
vi.mock("@/api/auth", () => ({ authApi: { getSession: vi.fn().mockResolvedValue(null) } }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies: [{ id: "company-1", issuePrefix: "PAP" }], selectedCompanyId: "company-1", setSelectedCompanyId: vi.fn() }),
}));

// Heavy children that are unrelated to the repository checkout picker.
vi.mock("./environment-variables-editor", () => ({ EnvironmentVariablesEditor: () => null }));
vi.mock("./InlineEditor", () => ({ InlineEditor: ({ value }: { value?: ReactNode }) => <div>{value}</div> }));
vi.mock("./PathInstructionsModal", () => ({ ChoosePathButton: () => null }));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    urlKey: "project-1",
    name: "Test project",
    description: "A long description that fills the value column",
    status: "in_progress",
    goalIds: [],
    goals: [],
    env: null,
    codebase: { workspaceId: null, repoUrl: null, repoRef: null, defaultRef: null, repoName: null },
    primaryWorkspace: null,
    workspaces: [],
    executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", allowIssueOverride: true },
    ...overrides,
  } as unknown as Project;
}

function primedClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.health, { hiddenSettings: [] });
  client.setQueryData(queryKeys.instance.experimentalSettings, { enableIsolatedWorkspaces: true });
  return client;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const repositoryWorkspace = (id: string, repoUrl: string) => ({ id, name: id, repoUrl, repoRef: "main", cwd: null, isPrimary: id === "api", metadata: null });

async function render(project: Project, onFieldUpdate: (field: string, data: Record<string, unknown>) => void) {
  act(() => {
    root.render(
      <QueryClientProvider client={primedClient()}>
        <TooltipProvider>
          <ProjectProperties project={project} onFieldUpdate={onFieldUpdate} onArchive={noop} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
}

const picker = () => container.querySelector<HTMLSelectElement>("[data-testid='project-repository-checkout']");
const twoRepositories = [repositoryWorkspace("api", "https://example.test/org/api.git"), repositoryWorkspace("web", "https://example.test/org/web.git")];

describe("ProjectProperties repository checkout", () => {
  it("is hidden for a project without repositories", async () => {
    await render(makeProject({ workspaces: [] }), vi.fn());
    expect(picker()).toBeNull();
  });

  it("offers on-demand checkout without the primary-only choice for a project with one repository", async () => {
    const onFieldUpdate = vi.fn();
    await render(makeProject({ workspaces: [twoRepositories[0]!] as unknown as Project["workspaces"] }), onFieldUpdate);
    expect([...picker()!.options].map(option => option.value)).toEqual(["all", "none"]);
    act(() => {
      picker()!.value = "none";
      picker()!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onFieldUpdate).toHaveBeenCalledWith("repository_checkout", { repositoryCheckout: "none" });
  });

  it("defaults to all repositories and saves the primary-only choice", async () => {
    const onFieldUpdate = vi.fn();
    await render(makeProject({ workspaces: twoRepositories as unknown as Project["workspaces"] }), onFieldUpdate);
    expect(picker()!.value).toBe("all");

    act(() => {
      picker()!.value = "primary";
      picker()!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onFieldUpdate).toHaveBeenCalledWith("repository_checkout", { repositoryCheckout: "primary" });
  });

  it("shows a saved primary-only choice", async () => {
    await render(makeProject({ workspaces: twoRepositories as unknown as Project["workspaces"], repositoryCheckout: "primary" }), vi.fn());
    expect(picker()!.value).toBe("primary");
    expect(container.textContent).toContain("Agents request the other repositories when a task needs them.");
  });

  it("shows a saved on-demand choice", async () => {
    await render(makeProject({ workspaces: twoRepositories as unknown as Project["workspaces"], repositoryCheckout: "none" }), vi.fn());
    expect(picker()!.value).toBe("none");
    expect(container.textContent).toContain("New tasks start in an empty task directory.");
  });
});