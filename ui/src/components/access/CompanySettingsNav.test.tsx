// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySettingsNav, getCompanySettingsTab } from "./CompanySettingsNav";

let currentPathname = "/company/settings";
const navigateMock = vi.hoisted(() => vi.fn());
const pageTabBarMock = vi.hoisted(() => vi.fn());
const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: currentPathname, search: "", hash: "" }),
  useNavigate: () => navigateMock,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div data-testid="tabs-root">{children}</div>,
}));

vi.mock("@/components/PageTabBar", () => ({
  PageTabBar: (props: {
    items: Array<{ value: string; label: string }>;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => {
    pageTabBarMock(props);

    return (
      <div>
        <div data-testid="active-tab">{props.value}</div>
        <button type="button" onClick={() => props.onValueChange?.("invites")}>
          switch-tab
        </button>
      </div>
    );
  },
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function renderWithQueryClient(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  root.render(
    <QueryClientProvider client={queryClient}>
      <CompanySettingsNav />
    </QueryClientProvider>,
  );
  return root;
}

describe("CompanySettingsNav", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubEnv("VITE_PAPERCLIP_EXPERIMENTAL_MODE", "true");
    container = document.createElement("div");
    document.body.appendChild(container);
    currentPathname = "/company/settings";
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: { id: "user-1", email: "admin@paperclip.local", name: "Admin", image: null },
      userId: "user-1",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
      memberships: [],
      source: "session",
      keyId: null,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("maps company settings routes to the expected shared tab value", () => {
    expect(getCompanySettingsTab("/company/settings")).toBe("general");
    expect(getCompanySettingsTab("/PAP/company/settings")).toBe("general");
    expect(getCompanySettingsTab("/company/settings/experimental-features")).toBe("experimental-features");
    expect(getCompanySettingsTab("/PAP/company/settings/experimental-features")).toBe("experimental-features");
    expect(getCompanySettingsTab("/company/settings/environments")).toBe("environments");
    expect(getCompanySettingsTab("/PAP/company/settings/environments")).toBe("environments");
    expect(getCompanySettingsTab("/company/settings/access")).toBe("access");
    expect(getCompanySettingsTab("/PAP/company/settings/access")).toBe("access");
    expect(getCompanySettingsTab("/company/settings/invites")).toBe("invites");
  });

  it("renders the active tab and navigates when a different tab is selected", async () => {
    currentPathname = "/PAP/company/settings/access";
    let root: ReturnType<typeof createRoot>;

    await act(async () => {
      root = renderWithQueryClient(container);
    });
    await flushReact();

    expect(container.textContent).toContain("access");
    expect(pageTabBarMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "access",
        items: [
          { value: "general", label: "General" },
          { value: "experimental-features", label: "Experimental" },
          { value: "environments", label: "Environments" },
          { value: "access", label: "Access" },
          { value: "invites", label: "Invites" },
        ],
      }),
    );

    const button = container.querySelector("button");
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(navigateMock).toHaveBeenCalledWith("/company/settings/invites");

    await act(async () => {
      root.unmount();
    });
  });

  it("hides the experimental tab when experimental mode is disabled", async () => {
    vi.stubEnv("VITE_PAPERCLIP_EXPERIMENTAL_MODE", "false");
    let root: ReturnType<typeof createRoot>;

    await act(async () => {
      root = renderWithQueryClient(container);
    });
    await flushReact();

    expect(pageTabBarMock).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          { value: "general", label: "General" },
          { value: "environments", label: "Environments" },
          { value: "access", label: "Access" },
          { value: "invites", label: "Invites" },
        ],
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("hides the experimental tab for non-admin users", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: { id: "user-1", email: "member@paperclip.local", name: "Member", image: null },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
      source: "session",
      keyId: null,
    });
    let root: ReturnType<typeof createRoot>;

    await act(async () => {
      root = renderWithQueryClient(container);
    });
    await flushReact();

    expect(pageTabBarMock).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          { value: "general", label: "General" },
          { value: "environments", label: "Environments" },
          { value: "access", label: "Access" },
          { value: "invites", label: "Invites" },
        ],
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });
});
