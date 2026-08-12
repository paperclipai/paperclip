// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryPicker } from "./RepositoryPicker";
import { buildNewProjectRequests } from "../lib/new-project-requests";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repositoriesApi = vi.hoisted(() => ({ list: vi.fn(), createManual: vi.fn() }));
vi.mock("../api/repositories", () => ({ repositoriesApi }));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function repository(id: string, name: string, projectCount = 0) {
  return {
    id,
    companyId: "company-1",
    connectionId: null,
    provider: "manual",
    providerRepositoryId: null,
    host: "github.com",
    owner: "acme",
    name,
    cloneUrl: `https://github.com/acme/${name}.git`,
    webUrl: `https://github.com/acme/${name}`,
    defaultBranch: "main",
    visibility: "private",
    state: "active",
    unavailableReason: null,
    providerMetadata: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    projectCount,
    directGrantCount: 0,
  } as const;
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void>;
  flushSync(() => { result = callback(); });
  await result!;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  repositoriesApi.list.mockResolvedValue([]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render(value: string[], onChange = vi.fn()) {
  await act(() => root.render(
    <QueryClientProvider client={client}>
      <RepositoryPicker companyId="company-1" value={value} onChange={onChange} />
    </QueryClientProvider>,
  ));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return onChange;
}

describe("RepositoryPicker", () => {
  it("supports non-code projects with zero repository hints", async () => {
    await render([]);
    expect(container.textContent).toContain("No repository hints");
  });

  it("selects reusable company repositories for cross-repository projects", async () => {
    repositoriesApi.list.mockResolvedValue([
      repository("repo-app", "app", 2),
      repository("repo-docs", "docs", 1),
    ]);
    const onChange = await render(["repo-app"]);
    expect(container.textContent).toContain("1 project");
    const docs = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("acme/docs"));
    await act(() => docs!.click());
    expect(onChange).toHaveBeenCalledWith(["repo-app", "repo-docs"]);
  });

  it("returns a nested newly-created repository as selected", async () => {
    const created = repository("repo-new", "new");
    repositoriesApi.createManual.mockResolvedValue(created);
    const onChange = await render([]);
    const addNew = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add new repository"));
    await act(() => addNew!.click());
    const cloneInput = container.querySelector<HTMLInputElement>('input[placeholder="https://github.com/org/repo.git"]')!;
    await act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(cloneInput, "https://github.com/acme/new.git");
      cloneInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add and select"));
    await act(() => submit!.click());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(repositoriesApi.createManual).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(["repo-new"]);
  });

  it("keeps repository hints out of execution workspace creation", () => {
    expect(buildNewProjectRequests({
      name: "Research",
      description: "",
      status: "planned",
      goalIds: [],
      targetDate: "",
      repositoryIds: ["repo-app", "repo-docs"],
      workspaceLocalPath: "",
    })).toEqual({
      project: { name: "Research", description: undefined, status: "planned", repositoryIds: ["repo-app", "repo-docs"] },
      workspace: null,
    });
  });
});
