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

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies: [{ id: "company-1", issuePrefix: "PAP" }], selectedCompanyId: "company-1", setSelectedCompanyId: vi.fn() }),
}));

// Heavy children that are unrelated to this control.
vi.mock("./environment-variables-editor", () => ({ EnvironmentVariablesEditor: () => null }));
vi.mock("./InlineEditor", () => ({ InlineEditor: ({ value }: { value?: ReactNode }) => <div>{value}</div> }));
vi.mock("./PathInstructionsModal", () => ({ ChoosePathButton: () => null }));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    urlKey: "project-1",
    name: "Test project",
    description: "",
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

function render(
  project: Project,
  onFieldUpdate: (field: string, data: Record<string, unknown>) => void,
  onDelete?: (deleteFiles: boolean) => void,
) {
  act(() => {
    root.render(
      <QueryClientProvider client={primedClient()}>
        <TooltipProvider>
          <ProjectProperties
            project={project}
            onFieldUpdate={onFieldUpdate}
            getFieldSaveState={() => "idle"}
            onArchive={noop}
            onDelete={onDelete}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
}

function concurrencySelect(): HTMLSelectElement {
  const el = container.querySelector<HTMLSelectElement>('select[aria-label="Shared workspace concurrency"]');
  if (!el) throw new Error("Shared workspace concurrency select not found");
  return el;
}

describe("ProjectProperties — shared workspace concurrency select", () => {
  it("defaults to Auto when the policy has no sharedWorkspaceConcurrency", () => {
    render(makeProject(), vi.fn());
    expect(concurrencySelect().value).toBe("auto");
    expect(container.textContent).toContain("Concurrent runs on local/SSH runners");
  });

  it("reflects an existing serialize value and shows its helper text", () => {
    render(
      makeProject({
        executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize" },
      } as Partial<Project>),
      vi.fn(),
    );
    expect(concurrencySelect().value).toBe("serialize");
    expect(container.textContent).toContain("Runs always take turns in the shared project workspace");
  });

  it("writes the picked value onto executionWorkspacePolicy when changed", () => {
    const onFieldUpdate = vi.fn();
    render(makeProject(), onFieldUpdate);
    const select = concurrencySelect();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, "allow");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onFieldUpdate).toHaveBeenCalledWith(
      "execution_workspace_shared_concurrency",
      expect.objectContaining({
        executionWorkspacePolicy: expect.objectContaining({ sharedWorkspaceConcurrency: "allow" }),
      }),
    );
  });
});

describe("ProjectProperties — permanent deletion", () => {
  function clickButton(label: string) {
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label),
    );
    if (!button) throw new Error(`Button not found: ${label}`);
    act(() => button.click());
  }

  it("requires confirmation and forwards the managed-file opt-in", () => {
    const onDelete = vi.fn();
    render(makeProject(), vi.fn(), onDelete);

    clickButton("Delete project");
    const checkbox = container.querySelector<HTMLElement>('[role="checkbox"]');
    if (!checkbox) throw new Error("Managed-file checkbox not found");
    act(() => checkbox.click());
    clickButton("Confirm delete");

    expect(onDelete).toHaveBeenCalledWith(true);
  });

  it("resets the managed-file opt-in when the project changes", () => {
    render(makeProject(), vi.fn(), vi.fn());
    clickButton("Delete project");
    const firstCheckbox = container.querySelector<HTMLElement>('[role="checkbox"]');
    if (!firstCheckbox) throw new Error("Managed-file checkbox not found");
    act(() => firstCheckbox.click());
    expect(firstCheckbox.getAttribute("aria-checked")).toBe("true");

    render(makeProject({ id: "project-2", urlKey: "project-2", name: "Second project" }), vi.fn(), vi.fn());
    clickButton("Delete project");
    const secondCheckbox = container.querySelector<HTMLElement>('[role="checkbox"]');
    expect(secondCheckbox?.getAttribute("aria-checked")).toBe("false");
  });
});
