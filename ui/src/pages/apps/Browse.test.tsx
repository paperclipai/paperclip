// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Browse } from "./Browse";

const listGalleryMock = vi.hoisted(() => vi.fn());
const listApplicationsMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const listUserDirectoryMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGallery: (companyId: string) => listGalleryMock(companyId),
    listApplications: (companyId: string) => listApplicationsMock(companyId),
    listConnections: (companyId: string) => listConnectionsMock(companyId),
  },
}));

vi.mock("@/api/access", () => ({
  accessApi: {
    listUserDirectory: (companyId: string) => listUserDirectoryMock(companyId),
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
        galleryEntry({ key: "notion", name: "Notion", tagline: "Read and update workspace content." }),
        galleryEntry({ key: "acme", name: "Acme CRM", tagline: "Sync deals and contacts." }),
      ],
    });
    listApplicationsMock.mockResolvedValue({ applications: [] });
    listConnectionsMock.mockResolvedValue({ connections: [] });
    listUserDirectoryMock.mockResolvedValue({ users: [] });
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
    expect(text).toContain("Choose an app or connect your own MCP server.");
    expect(text).not.toContain("More integrations are coming soon.");
    expect(text).not.toContain("Other integrations are previews.");
    expect(text).toContain("Popular");
    expect(text).toContain("All apps");
    expect(text).toContain("GitHub");
    expect(text).toContain("Slack");
    expect(text).toContain("Acme CRM");
    // Bring-your-own is a first-class row in the store.
    expect(text).toContain("Connect your own tool");
    expect(text).toContain("All discovered actions are enabled automatically.");
    expect(text).not.toContain("review its actions before enabling it");
  });

  it("enables Notion, Zapier, and custom URLs while fading unfinished integrations", async () => {
    await renderBrowse();

    const zapierTiles = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label="Connect for Zapier"]'),
    );
    const githubTiles = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label="Connect for GitHub"]'),
    );
    const notionTiles = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label="Connect for Notion"]'),
    );
    const tile = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Coming soon for Acme CRM"]',
    );
    const byoCard = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Connect your own tool"),
    );

    expect(zapierTiles).toHaveLength(2);
    expect(zapierTiles.every((button) => !button.disabled)).toBe(true);
    expect(notionTiles).toHaveLength(2);
    expect(notionTiles.every((button) => !button.disabled)).toBe(true);
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
      notionTiles[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/apps/connect?source=notion");

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

  it("shows the connected owner, edits existing connections, and offers a deliberate second account", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [
        { id: "app-notion", name: "Legacy integration", status: "active", applicationKey: "legacy:notion", metadata: {} },
      ],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        {
          id: "conn-one",
          applicationId: "app-notion",
          name: "Notion",
          status: "active",
          createdByUserId: "user-1",
          config: { sourceTemplateKey: "notion" },
          transportConfig: {},
        },
        { id: "conn-two", applicationId: "app-notion", status: "disabled" },
        { id: "conn-draft", applicationId: "app-notion", status: "draft" },
      ],
    });
    listUserDirectoryMock.mockResolvedValue({
      users: [{
        principalId: "user-1",
        status: "active",
        user: {
          id: "user-1",
          name: "Dotta",
          email: "dotta@example.com",
          image: "https://example.com/dotta.png",
        },
      }],
    });

    await renderBrowse();

    const editButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Edit connections for Notion"]',
      ),
    );
    expect(editButtons).toHaveLength(2);
    expect(editButtons.every((button) => button.textContent?.includes("Edit connections"))).toBe(true);
    // draft connections count toward the total (they are real, pending-setup connections)
    expect(container.textContent).toContain("3 connected");
    expect(container.textContent).toContain("Dotta’s Notion");
    expect(container.querySelector('[title="Dotta"] [data-slot="avatar"]')).toBeTruthy();

    await act(async () => {
      editButtons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/apps/app/app-notion/setup");

    const addAnother = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add another Notion account"]',
    );
    expect(addAnother?.textContent).toContain("Add new");
    await act(async () => {
      addAnother?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith(
      "/apps/connect?source=notion&applicationId=app-notion&name=Notion&new=1",
    );
  });

  it("treats an existing draft-only Notion connection as editable", async () => {
    const applicationId = "057a2df6-175f-4dde-b246-743706444122";
    const connectionId = "46dc23c1-ecfa-46f7-8e60-34a7cdbd661e";
    listApplicationsMock.mockResolvedValue({
      applications: [
        {
          id: applicationId,
          name: "Notion",
          status: "active",
          applicationKey: "notion",
          metadata: {},
        },
      ],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        {
          id: connectionId,
          applicationId,
          name: "Notion",
          status: "draft",
          config: { sourceTemplateKey: "notion" },
          transportConfig: {},
        },
      ],
    });

    await renderBrowse();

    const editButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Edit connection for Notion"]',
      ),
    );
    expect(editButtons).toHaveLength(2);
    expect(container.querySelector('button[aria-label="Connect for Notion"]')).toBeNull();
    expect(container.textContent).toContain("1 connected");
    expect(
      container.querySelector('button[aria-label="Add another Notion account"]')?.textContent,
    ).toContain("Add new");

    await act(async () => {
      editButtons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith(`/apps/${connectionId}/setup`);
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
