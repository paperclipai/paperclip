// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectProperties, type ProjectFieldSaveState } from "./ProjectProperties";
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

// Heavy children that are unrelated to the save indicator.
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

function render(getFieldSaveState: (field: string) => ProjectFieldSaveState) {
  act(() => {
    root.render(
      <QueryClientProvider client={primedClient()}>
        <TooltipProvider>
          <ProjectProperties
            project={makeProject()}
            onFieldUpdate={noop}
            getFieldSaveState={getFieldSaveState}
            onArchive={noop}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
}

function labelSpan(text: string): HTMLSpanElement {
  const span = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === text);
  if (!span) throw new Error(`Label "${text}" not rendered`);
  return span;
}

describe("ProjectProperties save indicator placement", () => {
  it("stacks the Saving indicator below the Description label instead of beside it", () => {
    render((field) => (field === "description" ? "saving" : "idle"));

    const label = labelSpan("Description");
    const wrapper = label.parentElement;
    expect(wrapper).not.toBeNull();
    // The label column is a fixed 80px wide; laying the indicator out inline
    // overflows into the description text. It must be a stacked column.
    expect(wrapper!.className).toContain("flex-col");
    expect(wrapper!.className).not.toContain("items-center");

    const indicator = label.nextElementSibling;
    expect(indicator).not.toBeNull();
    expect(indicator!.textContent).toContain("Saving");
    expect(wrapper!.contains(indicator!)).toBe(true);
  });

  it("renders the Saved indicator in the same stacked position once the save completes", () => {
    render((field) => (field === "description" ? "saved" : "idle"));

    const label = labelSpan("Description");
    expect(label.parentElement!.className).toContain("flex-col");
    expect(label.nextElementSibling?.textContent).toContain("Saved");
  });

  it("renders no indicator when the field is idle", () => {
    render(() => "idle");

    const label = labelSpan("Description");
    expect(label.nextElementSibling).toBeNull();
  });
});
