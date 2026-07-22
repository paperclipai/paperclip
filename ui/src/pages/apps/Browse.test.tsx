// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Browse } from "./Browse";

const listGalleryMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGallery: (companyId: string) => listGalleryMock(companyId),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => navigateMock,
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

function galleryEntry(overrides: Record<string, unknown>) {
  return {
    key: "github",
    name: "GitHub",
    logoUrl: "https://example.com/github.png",
    tagline: "Let agents open PRs and issues.",
    authKind: "oauth",
    transportTemplate: { transport: "mcp_remote", url: "https://api.github.com/mcp" },
    credentialFields: [],
    recommendedDefaults: {},
    urlPatterns: [],
    ...overrides,
  };
}

describe("Browse store door (PAP-13254 door 1)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    listGalleryMock.mockResolvedValue({
      apps: [
        galleryEntry({ key: "zapier", name: "Zapier", tagline: "Connect automations." }),
        galleryEntry({ key: "github", name: "GitHub", tagline: "Open PRs and issues." }),
        galleryEntry({ key: "slack", name: "Slack", tagline: "Post messages to channels." }),
        galleryEntry({ key: "acme", name: "Acme CRM", tagline: "Sync deals and contacts." }),
      ],
    });
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

  it("renders the store header, popular grid, gallery, and BYO card", async () => {
    await renderBrowse();

    const text = container.textContent ?? "";
    expect(text).toContain("Browse");
    expect(text).toContain("Connect Zapier or your own MCP server.");
    expect(text).toContain("Popular");
    expect(text).toContain("All apps");
    expect(text).toContain("GitHub");
    expect(text).toContain("Slack");
    expect(text).toContain("Acme CRM");
    // Bring-your-own is a first-class row in the store.
    expect(text).toContain("Connect your own tool");
  });

  it("enables Zapier and custom URLs while fading unfinished integrations", async () => {
    await renderBrowse();

    const zapierTiles = Array.from(container.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes("Zapier"),
    );
    const githubTiles = Array.from(container.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes("GitHub"),
    );
    const tile = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Acme CRM"),
    );
    const byoCard = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Connect your own tool"),
    );

    expect(zapierTiles).toHaveLength(2);
    expect(zapierTiles.every((button) => !button.disabled)).toBe(true);
    expect(githubTiles.every((button) => button.disabled)).toBe(true);
    expect(tile?.disabled).toBe(true);
    expect(byoCard?.disabled).toBe(false);
    expect(tile?.textContent).toContain("Coming soon");
    expect(zapierTiles[0]?.textContent).toContain("Connect");

    await act(async () => {
      zapierTiles[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/apps/connect?byo=1&source=zapier");

    await act(async () => {
      byoCard?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/apps/connect?byo=1");
  });

  it("filters the gallery by the search query", async () => {
    await renderBrowse();

    const input = container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, "slack");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const text = container.textContent ?? "";
    expect(text).toContain("Results (1)");
    expect(text).toContain("Slack");
    expect(text).not.toContain("Acme CRM");
    // Popular grid is hidden while searching.
    expect(text).not.toContain("Popular");
  });

  it("keeps the custom URL option available when gallery search has no matches", async () => {
    await renderBrowse();

    const input = container.querySelector<HTMLInputElement>('input[type="search"]');
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, "missing app");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("No planned apps match");
    expect(container.textContent).toContain("Connect your own tool");
  });
});
