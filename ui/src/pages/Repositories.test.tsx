// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repositories } from "./Repositories";

const companyState = vi.hoisted(() => ({ selectedCompanyId: "company-1" }));
const breadcrumbState = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));
const repositoriesApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  listConnections: vi.fn(),
  listProviders: vi.fn(),
  createManual: vi.fn(),
  syncConnection: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({ useCompany: () => companyState }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => breadcrumbState }));
vi.mock("../api/repositories", () => ({ repositoriesApi: repositoriesApiMock }));
vi.mock("../components/repositories/GitHubConnectionDialog", () => ({
  GitHubConnectionDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="github-dialog" /> : null),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void, attempts = 50) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function provider(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    provider: "github",
    host: "github.com",
    displayName: "GitHub",
    description: null,
    source: "core",
    pluginKey: null,
    supportsDiscovery: true,
    supportsCloneCredentials: true,
    documentationUrl: null,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "repo-1",
    companyId: "company-1",
    connectionId: null,
    provider: "manual",
    providerRepositoryId: null,
    host: "github.com",
    owner: "acme",
    name: "alpha",
    cloneUrl: "https://github.com/acme/alpha.git",
    webUrl: "https://github.com/acme/alpha",
    defaultBranch: "main",
    visibility: "private",
    state: "active",
    unavailableReason: null,
    providerMetadata: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectCount: 2,
    directGrantCount: 1,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/repositories"]}>
          <Repositories />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

describe("Repositories catalog", () => {
  beforeEach(() => {
    repositoriesApiMock.list.mockReset();
    repositoriesApiMock.listConnections.mockReset();
    repositoriesApiMock.listProviders.mockReset();
    repositoriesApiMock.createManual.mockReset();
    repositoriesApiMock.syncConnection.mockReset();
    repositoriesApiMock.listConnections.mockResolvedValue([]);
    repositoriesApiMock.listProviders.mockResolvedValue([provider()]);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("shows an empty state with a connect action", async () => {
    repositoriesApiMock.list.mockResolvedValue([]);
    render();
    await waitFor(() => {
      expect(document.body.textContent).toContain("No repositories yet");
      expect(document.body.textContent).toContain("Connect GitHub");
    });
  });

  it("renders a populated catalog with project and grant counts and filters on search", async () => {
    repositoriesApiMock.list.mockResolvedValue([
      makeRepo(),
      makeRepo({ id: "repo-2", name: "beta", projectCount: 0, directGrantCount: 0 }),
    ]);
    render();
    await waitFor(() => {
      expect(document.body.textContent).toContain("acme/alpha");
      expect(document.body.textContent).toContain("acme/beta");
      expect(document.body.textContent).toContain("2 projects");
      expect(document.body.textContent).toContain("1 grant");
    });

    const searchInput = container.querySelector<HTMLInputElement>('input[aria-label="Search repositories"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(searchInput, "beta");
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => {
      expect(document.body.textContent).toContain("acme/beta");
      expect(document.body.textContent).not.toContain("acme/alpha");
    });
  });

  it("shows an error state with retry", async () => {
    repositoriesApiMock.list.mockRejectedValue(new Error("boom"));
    render();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Failed to load repositories");
      expect(document.body.textContent).toContain("Retry");
    });
  });

  it("supports the manual repository fallback", async () => {
    repositoriesApiMock.list.mockResolvedValue([makeRepo()]);
    repositoriesApiMock.createManual.mockResolvedValue(makeRepo({ id: "repo-manual", name: "manual" }));
    render();
    await waitFor(() => expect(document.body.textContent).toContain("acme/alpha"));

    const addButtons = [...document.querySelectorAll("button")].filter((b) => b.textContent?.includes("Add manually"));
    addButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(document.body.textContent).toContain("Add a repository manually"));

    const urlInput = document.querySelector<HTMLInputElement>("#manual-clone-url")!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(urlInput, "https://github.com/acme/manual.git");
    urlInput.dispatchEvent(new Event("input", { bubbles: true }));

    await waitFor(() => {
      const submit = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Add repository"));
      expect(submit && !(submit as HTMLButtonElement).disabled).toBe(true);
    });
    const submit = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Add repository"))!;
    submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await waitFor(() => {
      expect(repositoriesApiMock.createManual).toHaveBeenCalledWith("company-1", {
        cloneUrl: "https://github.com/acme/manual.git",
        visibility: "unknown",
      });
    });
  });

  // One `github` key can be served by github.com and by an enterprise install
  // an extension registered. The server refuses an ambiguous lookup, so the page
  // has to offer each host as its own action.
  it("offers one connect action per host when several serve the github provider", async () => {
    repositoriesApiMock.list.mockResolvedValue([makeRepo()]);
    repositoriesApiMock.listProviders.mockResolvedValue([
      provider(),
      provider({ host: "github.acme-corp.example", source: "plugin", pluginKey: "acme.github-enterprise" }),
    ]);
    render();

    await waitFor(() => {
      const labels = [...document.querySelectorAll("button")].map((button) => button.textContent ?? "");
      expect(labels.some((label) => label.includes("Connect github.com"))).toBe(true);
      expect(labels.some((label) => label.includes("Connect github.acme-corp.example"))).toBe(true);
    });
  });
});
