// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubConnectionDialog } from "./GitHubConnectionDialog";

const repositoriesApiMock = vi.hoisted(() => ({
  beginConnection: vi.fn(),
  completeConnection: vi.fn(),
  discoverConnectionRepositories: vi.fn(),
  importConnectionRepositories: vi.fn(),
}));

vi.mock("../../api/repositories", () => ({ repositoriesApi: repositoriesApiMock }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const windowOpen = vi.fn();
vi.stubGlobal("open", windowOpen);

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void, attempts = 80) {
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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function clickByText(text: string) {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`button "${text}" not found`);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function discoveryPage(overrides: Partial<{ items: unknown[]; nextCursor: string | null; total: number | null }> = {}) {
  return {
    connectionId: "conn-1",
    items: [
      { providerRepositoryId: "1", owner: "acme", name: "alpha", cloneUrl: "https://github.com/acme/alpha.git", webUrl: null, defaultBranch: "main", visibility: "private", archived: false, imported: false, importedRepositoryId: null, metadata: null },
      { providerRepositoryId: "2", owner: "acme", name: "beta", cloneUrl: "https://github.com/acme/beta.git", webUrl: null, defaultBranch: "main", visibility: "private", archived: false, imported: true, importedRepositoryId: "repo-2", metadata: null },
    ],
    nextCursor: null,
    total: 2,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <GitHubConnectionDialog companyId="company-1" open onOpenChange={() => {}} />
      </QueryClientProvider>,
    );
  });
}

describe("GitHubConnectionDialog", () => {
  beforeEach(() => {
    for (const fn of Object.values(repositoriesApiMock)) fn.mockReset();
    windowOpen.mockReset();
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  async function reachSelectStep() {
    repositoriesApiMock.beginConnection.mockResolvedValue({
      provider: "github",
      installUrl: "https://github.com/apps/paperclip/installations/new?state=abc",
      state: "signed-state",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    repositoriesApiMock.completeConnection.mockResolvedValue({
      connection: { id: "conn-1", provider: "github", installationId: "42", accountName: "acme" },
      created: true,
      repositories: [],
    });
    repositoriesApiMock.discoverConnectionRepositories.mockResolvedValue(discoveryPage());
    render();

    clickByText("Authorize on GitHub");
    await waitFor(() => expect(windowOpen).toHaveBeenCalled());
    setInputValue(document.querySelector<HTMLInputElement>("#github-installation-id")!, "42");
    clickByText("Continue");
    await waitFor(() => {
      expect(repositoriesApiMock.completeConnection).toHaveBeenCalledWith("company-1", "github", {
        state: "signed-state",
        installationId: "42",
      });
      expect(document.body.textContent).toContain("acme/alpha");
    });
  }

  it("runs authorize -> complete -> discover and imports a partial multi-select", async () => {
    repositoriesApiMock.importConnectionRepositories.mockResolvedValue({
      repositories: [{ id: "repo-1" }],
      imported: 1,
      skipped: [],
    });
    await reachSelectStep();

    // Already-imported repositories are disabled; select only the importable one.
    const alphaCheckbox = document.querySelector<HTMLButtonElement>('[aria-label="Select acme/alpha"]')!;
    const betaCheckbox = document.querySelector<HTMLButtonElement>('[aria-label="Select acme/beta"]')!;
    expect(betaCheckbox.getAttribute("disabled") !== null || betaCheckbox.getAttribute("data-disabled") !== null).toBe(true);
    alphaCheckbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await waitFor(() => {
      const importButton = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Import"));
      expect(importButton && !(importButton as HTMLButtonElement).disabled).toBe(true);
    });
    clickByText("Import");

    await waitFor(() => {
      expect(repositoriesApiMock.importConnectionRepositories).toHaveBeenCalledWith("conn-1", ["1"]);
      expect(document.body.textContent).toContain("Imported 1 repository");
    });
  });

  it("supports search and pagination during discovery", async () => {
    await reachSelectStep();
    repositoriesApiMock.discoverConnectionRepositories.mockClear();
    repositoriesApiMock.discoverConnectionRepositories.mockResolvedValue(discoveryPage({ items: [], total: 0 }));

    setInputValue(document.querySelector<HTMLInputElement>('input[aria-label="Search repositories"]')!, "zzz");
    clickByText("Search");
    await waitFor(() => {
      expect(repositoriesApiMock.discoverConnectionRepositories).toHaveBeenCalledWith("conn-1", {
        query: "zzz",
        cursor: null,
        pageSize: 20,
      });
      expect(document.body.textContent).toContain("No repositories found");
    });
  });

  it("shows an error and allows retry when authorization fails", async () => {
    repositoriesApiMock.beginConnection.mockRejectedValueOnce(new Error("network down"));
    render();
    clickByText("Authorize on GitHub");
    await waitFor(() => expect(document.body.textContent).toContain("network down"));

    repositoriesApiMock.beginConnection.mockResolvedValueOnce({
      provider: "github",
      installUrl: "https://github.com/apps/paperclip/installations/new?state=abc",
      state: "signed-state",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    clickByText("Authorize on GitHub");
    await waitFor(() => expect(windowOpen).toHaveBeenCalled());
  });
});
