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

const environmentOptions = vi.hoisted(() => ({ groups: [
  { storageProviderPluginId: null, environments: [{ id: "local", name: "Local" }, { id: "sandbox", name: "Paperclip Sandbox" }] },
  { storageProviderPluginId: "provider-one", environments: [{ id: "computer", name: "Agent computers" }] },
], defaultEnvironmentId: "local", error: null }));
vi.mock("../api/projects", () => ({ projectsApi: { createWorkspace: vi.fn(), removeWorkspace: vi.fn(), updateWorkspace: vi.fn(),
  environmentOptions: vi.fn(async () => environmentOptions) } }));
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

function primedClient(hiddenSettings: string[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.health, { hiddenSettings });
  client.setQueryData(queryKeys.instance.experimentalSettings, { enableIsolatedWorkspaces: true });
  client.setQueryData(queryKeys.projects.environments("company-1"), environmentOptions);
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

function render(project: Project, onFieldUpdate: (field: string, data: Record<string, unknown>) => void, hiddenSettings: string[] = []) {
  act(() => {
    root.render(
      <QueryClientProvider client={primedClient(hiddenSettings)}>
        <TooltipProvider>
          <ProjectProperties project={project} onFieldUpdate={onFieldUpdate} getFieldSaveState={() => "idle"} onArchive={noop} />
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
    expect(container.textContent).toContain("Sandbox runs take turns in the shared project workspace");
    expect(container.textContent).toContain("Local/SSH folders allow concurrent runs");
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

it("hides project isolation controls without rewriting its policy", () => {
  const onFieldUpdate = vi.fn();
  render(makeProject(), onFieldUpdate, ["workspaces.isolation"]);
  expect(container.textContent).not.toContain("Execution Workspaces");
  expect(container.textContent).not.toContain("Enable isolated task checkouts");
  expect(container.querySelector('select[aria-label="Shared workspace concurrency"]')).toBeNull();
  expect(onFieldUpdate).not.toHaveBeenCalled();
});


describe("ProjectProperties — workspace storage availability", () => {
  const inherited = {
    source: "core" as const, pluginId: null, displayName: "Managed storage", error: null,
    effectivePolicy: { enabled: true, defaultMode: "isolated_workspace" as const, storageProviderPluginId: "provider-one", workspaceStrategy: { type: "git_worktree" as const } },
    providers: [{ id: "provider-one", displayName: "Managed storage", isDefault: true }, { id: "provider-two", displayName: "Alternative", isDefault: false }],
  };
  const core = { source: "core" as const, pluginId: null, displayName: "Core / local", error: null, effectivePolicy: null, providers: inherited.providers };
  function note() { return container.querySelector('[data-testid="project-storage-availability"]'); }
  it("offers no storage or environment control", () => {
    render(makeProject({ companyId: "company-1", executionWorkspacePolicy: null, workspaceProvider: core }), vi.fn());
    expect(container.querySelector('select[aria-label="Workspace storage provider"]')).toBeNull();
    expect(container.querySelector('select[id^="project-environment-"]')).toBeNull();
  });
  it("hides the note when no storage plugin is installed", () => {
    render(makeProject({ companyId: "company-1", executionWorkspacePolicy: null, workspaceProvider: { ...core, providers: [] } }), vi.fn());
    expect(note()).toBeNull();
    expect(container.textContent).not.toContain("Available in");
  });
  it("lists the environments that share a core project's storage when a plugin is installed", () => {
    render(makeProject({ companyId: "company-1", executionWorkspacePolicy: null, workspaceProvider: core }), vi.fn());
    expect(note()?.textContent).toContain("Available in");
    expect(note()?.textContent).toContain("Local, Paperclip Sandbox");
    expect(note()?.textContent).not.toContain("Agent computers");
    expect(note()?.textContent).toContain("Core / local workspace storage was chosen when this project was created");
  });
  it("lists the plugin's environments for a plugin-backed project", () => {
    render(makeProject({ companyId: "company-1", executionWorkspacePolicy: { enabled: true, storageProviderPluginId: "provider-one" },
      workspaceProvider: { ...inherited, source: "project" as const, pluginId: "provider-one" } }), vi.fn());
    expect(note()?.textContent).toContain("Agent computers");
    expect(note()?.textContent).not.toContain("Paperclip Sandbox");
    expect(note()?.textContent).toContain("Managed storage workspace storage");
  });
  it("reports an uninstalled storage plugin instead of hiding the note", () => {
    render(makeProject({ companyId: "company-1", executionWorkspacePolicy: { enabled: true, storageProviderPluginId: "provider-one" },
      workspaceProvider: { ...inherited, source: "project" as const, pluginId: "provider-one", displayName: "Unavailable provider",
        providers: [], error: "The workspace storage plugin is unavailable" } }), vi.fn());
    expect(note()?.querySelector('[role="alert"]')?.textContent).toBe("Storage plugin unavailable");
    expect(note()?.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
  it("does not copy inherited mode, strategy, or provider when another setting changes", () => {
    const onFieldUpdate = vi.fn();
    render(makeProject({ executionWorkspacePolicy: null, workspaceProvider: inherited }), onFieldUpdate);
    act(() => { concurrencySelect().value = "allow"; concurrencySelect().dispatchEvent(new Event("change", { bubbles: true })); });
    expect(onFieldUpdate).toHaveBeenCalledWith("execution_workspace_shared_concurrency", { executionWorkspacePolicy: { enabled: true, sharedWorkspaceConcurrency: "allow" } });
  });
  it("shows a provider configuration error", () => {
    render(makeProject({ workspaceProvider: { ...inherited, error: "The workspace storage plugin is unavailable" } }), vi.fn());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("unavailable");
  });
});
