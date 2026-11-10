// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projectsApi } from "../api/projects";
import { ProjectProperties } from "./ProjectProperties";
import { TooltipProvider } from "./ui/tooltip";
import { queryKeys } from "../lib/queryKeys";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const options = vi.hoisted(() => ({ groups: [
  { storageProviderPluginId: null, environments: [{ id: "local", name: "Local" }, { id: "ssh", name: "Build host" }] },
  { storageProviderPluginId: "plugin", environments: [{ id: "computer", name: "Computers" }] },
], defaultEnvironmentId: "local", error: null }));
vi.mock("../api/projects", () => ({ projectsApi: { environmentOptions: vi.fn(async () => options) } }));
vi.mock("../api/secrets", () => ({ secretsApi: { list: vi.fn(async () => []), listUserSecretDefinitions: vi.fn(async () => []) } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn(async () => ({ enableEnvironments: true, enableIsolatedWorkspaces: false })) } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company", companies: [] }) }));
vi.mock("./ProjectRepositories", () => ({ ProjectRepositories: () => null }));
vi.mock("./ProjectGitAuthorization", () => ({ ProjectGitAuthorization: () => null }));
vi.mock("./ProjectAccessMembers", () => ({ ProjectAccessMembers: () => null }));
vi.mock("./environment-variables-editor", () => ({ EnvironmentVariablesEditor: () => null }));
vi.mock("./PathInstructionsModal", () => ({ ChoosePathButton: () => null }));

const update = vi.fn();
let container: HTMLDivElement, root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { flushSync(() => root.unmount()); container.remove(); vi.clearAllMocks(); });

function makeProject(id: string): Project {
  return { id, companyId: "company", name: id, urlKey: id, status: "planned", goalIds: [], goals: [], env: null,
    environmentId: "local", executionWorkspacePolicy: null, workspaces: [], primaryWorkspace: null,
    workspaceProvider: { source: "core", pluginId: null, displayName: "Core / local", providers: [{ id: "plugin", displayName: "Managed storage" }], effectivePolicy: null, error: null },
    codebase: { workspaceId: null, repoUrl: null, repoRef: null, defaultRef: null, repoName: null },
  } as unknown as Project;
}

function renderProjects(seedOptions = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.health, { hiddenSettings: [] });
  client.setQueryData(queryKeys.instance.experimentalSettings, { enableEnvironments: true, enableIsolatedWorkspaces: false });
  if (seedOptions) client.setQueryData(queryKeys.projects.environments("company"), options);
  function Projects() {
    const [projects, setProjects] = useState([makeProject("first"), makeProject("second")]);
    return projects.map(project => <fieldset key={project.id} data-project={project.id}>
      <ProjectProperties project={project} onFieldUpdate={(field, data) => {
        update(project.id, field, data);
        setProjects(previous => previous.map(value => value.id === project.id ? { ...value, ...data } as Project : value));
      }} />
    </fieldset>);
  }
  flushSync(() => root.render(<QueryClientProvider client={client}><TooltipProvider><Projects /></TooltipProvider></QueryClientProvider>));
  return client;
}

it("keeps environment selection on its project with isolation disabled and a shared query cache", () => {
  const client = renderProjects();
  const first = container.querySelector<HTMLSelectElement>('[data-project="first"] select[id^="project-environment-"]')!;
  const second = container.querySelector<HTMLSelectElement>('[data-project="second"] select[id^="project-environment-"]')!;
  expect(first.value).toBe("local");
  expect(second.value).toBe("local");
  expect([...first.options].map(option => option.value)).not.toContain("computer");
  flushSync(() => { first.value = "ssh"; first.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(update).toHaveBeenCalledExactlyOnceWith("first", "execution_workspace_environment", { environmentId: "ssh", expectedStorageProviderPluginId: null });
  expect(first.value).toBe("ssh");
  expect(second.value).toBe("local");
  expect(client.getQueryData(queryKeys.projects.environments("company"))).toEqual(options);
  flushSync(() => { first.value = ""; first.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(update).toHaveBeenLastCalledWith("first", "execution_workspace_environment", { environmentId: null });
  expect(second.value).toBe("local");
});

it("changes storage and the compatible environment together on only the selected project", () => {
  renderProjects();
  const firstStorage = container.querySelector<HTMLSelectElement>('[data-project="first"] select#workspace-storage-provider')!;
  flushSync(() => { firstStorage.value = "plugin"; firstStorage.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(update).toHaveBeenCalledExactlyOnceWith("first", "workspace_storage_provider", {
    executionWorkspacePolicy: { enabled: true, storageProviderPluginId: "plugin" },
    environmentId: "computer", expectedStorageProviderPluginId: "plugin",
  });
  expect(container.querySelector<HTMLSelectElement>('[data-project="first"] select[id^="project-environment-"]')!.value).toBe("computer");
  expect(container.querySelector<HTMLSelectElement>('[data-project="second"] select[id^="project-environment-"]')!.value).toBe("local");
});

it("keeps the saved mapping and allows an explicit clear while the environment list loads", () => {
  vi.mocked(projectsApi.environmentOptions).mockReturnValueOnce(new Promise(() => {}));
  renderProjects(false);
  const first = container.querySelector<HTMLSelectElement>('[data-project="first"] select[id^="project-environment-"]')!;
  expect(first.value).toBe("local");
  expect(first.selectedOptions[0].textContent).toBe("Saved environment");
  expect(first.disabled).toBe(false);
  flushSync(() => { first.value = ""; first.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(update).toHaveBeenCalledExactlyOnceWith("first", "execution_workspace_environment", { environmentId: null });
  expect(container.querySelector<HTMLSelectElement>('[data-project="second"] select[id^="project-environment-"]')!.value).toBe("local");
});
