// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project, ProjectCodebase } from "@paperclipai/shared";
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
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn().mockResolvedValue({}) } }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies: [{ id: "company-1", issuePrefix: "PAP" }], selectedCompanyId: "company-1", setSelectedCompanyId: vi.fn() }),
}));

vi.mock("./environment-variables-editor", () => ({ EnvironmentVariablesEditor: () => null }));
vi.mock("./InlineEditor", () => ({ InlineEditor: ({ value }: { value?: ReactNode }) => <div>{value}</div> }));

const LOCAL_FOLDER = "/Users/paperclip/projects/test-project";
const MANAGED_FOLDER = "/var/paperclip/checkouts/test-project";

function makeCodebase(overrides: Partial<ProjectCodebase> = {}): ProjectCodebase {
  return {
    workspaceId: "workspace-1",
    repoUrl: "https://github.com/paperclipai/paperclip",
    repoRef: "master",
    defaultRef: "origin/master",
    repoName: "paperclipai/paperclip",
    localFolder: LOCAL_FOLDER,
    managedFolder: MANAGED_FOLDER,
    effectiveLocalFolder: LOCAL_FOLDER,
    origin: "local_folder",
    ...overrides,
  };
}

function makeProject(codebase: ProjectCodebase): Project {
  return {
    id: "project-1",
    urlKey: "project-1",
    name: "Test project",
    description: "",
    status: "in_progress",
    goalIds: [],
    goals: [],
    env: null,
    codebase,
    primaryWorkspace: null,
    workspaces: [],
    executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", allowIssueOverride: true },
  } as unknown as Project;
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

/** Pass `null` for `experimentalSettings` to render with the policy unresolved. */
function render(project: Project, experimentalSettings: Record<string, unknown> | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (experimentalSettings) {
    client.setQueryData(queryKeys.instance.experimentalSettings, experimentalSettings);
  }
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ProjectProperties project={project} onFieldUpdate={vi.fn()} getFieldSaveState={() => "idle"} onArchive={noop} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
}

function buttonLabels() {
  return Array.from(container.querySelectorAll("button")).map((button) => button.textContent?.trim() ?? "");
}

describe("ProjectProperties — local folder under the managed-sandbox-only policy", () => {
  it("shows the folder path and its controls when the policy is off", () => {
    render(makeProject(makeCodebase()), { enableIsolatedWorkspaces: true });

    expect(container.textContent).toContain("Local folder");
    expect(container.textContent).toContain(LOCAL_FOLDER);
    expect(buttonLabels()).toContain("Change local folder");
    expect(container.querySelector('button[aria-label="Clear local folder"]')).not.toBeNull();
  });

  it("hides the folder path and its controls when the policy is on", () => {
    render(makeProject(makeCodebase()), {
      enableIsolatedWorkspaces: true,
      enableManagedSandboxOnly: true,
    });

    expect(container.textContent).not.toContain("Local folder");
    expect(container.textContent).not.toContain(LOCAL_FOLDER);
    expect(buttonLabels()).not.toContain("Change local folder");
    expect(container.querySelector('button[aria-label="Clear local folder"]')).toBeNull();
    // The repo row is unrelated to the host filesystem, so it stays.
    expect(container.textContent).toContain("Repo");
  });

  it("keeps only the managed-folder label for a managed checkout when the policy is on", () => {
    render(
      makeProject(makeCodebase({
        localFolder: null,
        effectiveLocalFolder: MANAGED_FOLDER,
        origin: "managed_checkout",
      })),
      { enableIsolatedWorkspaces: true, enableManagedSandboxOnly: true },
    );

    expect(container.textContent).toContain("Paperclip-managed folder.");
    expect(container.textContent).not.toContain(MANAGED_FOLDER);
    expect(container.querySelector(".font-mono")?.textContent).not.toBe(MANAGED_FOLDER);
    expect(buttonLabels()).not.toContain("Set local folder");
  });

  it("keeps the folder path hidden while the policy is still loading", () => {
    // A cold cache resolves the policy to false on the first render. The guard
    // fails closed so a managed instance never flashes the execution-host path.
    render(makeProject(makeCodebase()), null);

    expect(container.textContent).not.toContain("Local folder");
    expect(container.textContent).not.toContain(LOCAL_FOLDER);
    expect(container.textContent).toContain("Repo");
  });

  it("never opens the absolute-path edit panel when the policy is on", () => {
    render(makeProject(makeCodebase()), {
      enableIsolatedWorkspaces: true,
      enableManagedSandboxOnly: true,
    });

    const pathInput = container.querySelector('input[placeholder="/absolute/path/to/workspace"]');
    expect(pathInput).toBeNull();
  });
});
