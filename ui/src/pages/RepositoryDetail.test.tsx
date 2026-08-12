// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryDetail } from "./RepositoryDetail";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repositoriesApi = vi.hoisted(() => ({
  get: vi.fn(),
  getRelationships: vi.fn(),
  attachProjectRepository: vi.fn(),
  detachProjectRepository: vi.fn(),
  grantAgentRepository: vi.fn(),
  revokeAgentRepository: vi.fn(),
}));
vi.mock("../api/repositories", () => ({ repositoriesApi }));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => ({ repositoryId: "repo-1" }),
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void>;
  flushSync(() => { result = callback(); });
  await result!;
}

describe("RepositoryDetail", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    repositoriesApi.get.mockResolvedValue({
      id: "repo-1",
      owner: "acme",
      name: "app",
      host: "github.com",
      defaultBranch: "main",
    });
    repositoriesApi.getRelationships.mockResolvedValue({
      projects: [{ id: "project-1", name: "Project One", displayOrder: 0 }],
      agents: [
        {
          id: "agent-direct",
          name: "Direct and inherited",
          title: "Engineer",
          sources: { direct: true, projects: [{ id: "project-1", name: "Project One" }] },
        },
        {
          id: "agent-inherited",
          name: "Inherited only",
          title: "Engineer",
          sources: { direct: false, projects: [{ id: "project-1", name: "Project One" }] },
        },
      ],
    });
    repositoriesApi.revokeAgentRepository.mockResolvedValue({ removed: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("distinguishes direct grants from inherited project access and revokes only the direct source", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(() => root.render(
      <QueryClientProvider client={client}>
        <RepositoryDetail />
      </QueryClientProvider>,
    ));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(container.textContent).toContain("This is guidance, not a boundary");
    expect(container.textContent).toContain("Direct grant · Also inherited through Project One");
    expect(container.textContent).toContain("Inherited through projects (1)");
    expect(container.textContent).toContain("Inherited through Project One · managed on those projects");
    const revoke = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Revoke direct grant"));
    await act(() => revoke!.click());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(repositoriesApi.revokeAgentRepository).toHaveBeenCalledWith("agent-direct", "repo-1");
  });
});
