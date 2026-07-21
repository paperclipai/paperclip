// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CONNECTABLE_APP_DEFINITIONS } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Browse } from "./Browse";

const listGalleryMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const setSearchParamsMock = vi.hoisted(() => vi.fn());
const mockSearch = vi.hoisted(() => ({ value: "" }));

vi.mock("@/api/tools", () => ({
  toolsApi: { listGallery: (companyId: string) => listGalleryMock(companyId) },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams(mockSearch.value), setSearchParamsMock],
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function tileFor(name: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(name),
  ) as HTMLButtonElement | undefined;
}

const GITHUB = CONNECTABLE_APP_DEFINITIONS.find((a) => a.slug === "github")!;
const SLACK = CONNECTABLE_APP_DEFINITIONS.find((a) => a.slug === "slack")!;

describe("Browse store door — Connections v3 §3", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mockSearch.value = "";
    listGalleryMock.mockResolvedValue({ apps: CONNECTABLE_APP_DEFINITIONS });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderBrowse() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Browse />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders the header, a category rail, and the gallery", async () => {
    await renderBrowse();
    const text = container.textContent ?? "";
    expect(text).toContain("Browse");
    expect(text).toContain("All apps");
    // Category rail carries the categories present in the catalog.
    expect(container.querySelector('nav[aria-label="Categories"]')).toBeTruthy();
    expect(text).toContain(GITHUB.name);
    expect(text).toContain(SLACK.name);
  });

  it("every tile is clickable and opens the wizard for that app (no 'Coming soon')", async () => {
    await renderBrowse();
    expect(container.textContent).not.toContain("Coming soon");
    const tile = tileFor(SLACK.name);
    expect(tile).toBeTruthy();
    expect(tile?.disabled).toBe(false);
    await act(async () => {
      tile?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith(`/apps/connect/${SLACK.slug}`);
  });

  it("filters by search query via the URL param", async () => {
    mockSearch.value = "q=slack";
    await renderBrowse();
    const text = container.textContent ?? "";
    expect(text).toContain("Results (1)");
    expect(text).toContain(SLACK.name);
    expect(text).not.toContain(GITHUB.name);
  });

  it("surfaces a suggest-a-connector card in empty search results", async () => {
    mockSearch.value = "q=definitely-not-a-connector";
    await renderBrowse();
    const text = container.textContent ?? "";
    expect(text).toContain("Suggest a connector");
    expect(text).toContain("No connectors match");
  });

  it("selecting a category writes the category URL param", async () => {
    await renderBrowse();
    const devButton = Array.from(
      container.querySelectorAll('nav[aria-label="Categories"] button'),
    ).find((b) => b.textContent?.includes("Developer"));
    expect(devButton).toBeTruthy();
    await act(async () => {
      devButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(setSearchParamsMock).toHaveBeenCalled();
    const [params] = setSearchParamsMock.mock.calls.at(-1)!;
    expect((params as URLSearchParams).get("category")).toBe("developer");
  });
});
