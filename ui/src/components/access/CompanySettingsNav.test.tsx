// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCurrentBoardAccess } from "@/test-utils/currentBoardAccess";
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

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function asyncAct(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("CompanySettingsNav", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentPathname = "/company/settings";
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(
      buildCurrentBoardAccess({ isInstanceAdmin: true }),
    );
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("maps company settings routes to the expected shared tab value", () => {
    expect(getCompanySettingsTab("/company/settings")).toBe("general");
    expect(getCompanySettingsTab("/PAP/company/settings")).toBe("general");
    expect(getCompanySettingsTab("/company/settings/environments")).toBe("instance-environments");
    expect(getCompanySettingsTab("/company/settings/cloud-upstream")).toBe("cloud-upstream");
    expect(getCompanySettingsTab("/company/settings/members")).toBe("members");
    expect(getCompanySettingsTab("/PAP/company/settings/members")).toBe("members");
    expect(getCompanySettingsTab("/company/settings/access")).toBe("members");
    expect(getCompanySettingsTab("/PAP/company/settings/access")).toBe("members");
    expect(getCompanySettingsTab("/company/settings/invites")).toBe("invites");
    expect(getCompanySettingsTab("/PAP/company/settings/secrets")).toBe("secrets");
    expect(getCompanySettingsTab("/company/settings/instance/profile")).toBe("instance-profile");
    expect(getCompanySettingsTab("/PAP/company/settings/instance/general")).toBe("instance-general");
    expect(getCompanySettingsTab("/company/settings/instance/environments")).toBe("instance-environments");
    expect(getCompanySettingsTab("/company/settings/instance/access")).toBe("instance-access");
    expect(getCompanySettingsTab("/company/settings/instance/heartbeats")).toBe("instance-heartbeats");
    expect(getCompanySettingsTab("/company/settings/instance/experimental")).toBe("instance-experimental");
    expect(getCompanySettingsTab("/PAP/company/settings/instance/plugins/example")).toBe("instance-plugins");
    expect(getCompanySettingsTab("/company/settings/instance/adapters")).toBe("instance-adapters");
  });

  it("renders the active tab and navigates when a different tab is selected", async () => {
    currentPathname = "/PAP/company/settings/members";
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await asyncAct(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsNav />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("members");
    expect(pageTabBarMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "members",
        items: [
          { value: "general", label: "General" },
          { value: "members", label: "Members" },
          { value: "invites", label: "Invites" },
          { value: "secrets", label: "Secrets" },
          { value: "instance-profile", label: "Instance profile" },
          { value: "instance-general", label: "Instance general" },
          { value: "instance-environments", label: "Instance environments" },
          { value: "instance-access", label: "Instance access" },
          { value: "instance-heartbeats", label: "Instance heartbeats" },
          { value: "instance-experimental", label: "Instance experimental" },
          { value: "instance-plugins", label: "Instance plugins" },
          { value: "instance-adapters", label: "Instance adapters" },
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

  it("filters tabs by exposed surfaces and admin status", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(
      buildCurrentBoardAccess({
        isInstanceAdmin: false,
        exposedSurfaces: ["company.general", "company.secrets"],
      }),
    );
    currentPathname = "/company/settings";
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await asyncAct(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsNav />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const rendered = pageTabBarMock.mock.calls.at(-1)?.[0] as {
      items: Array<{ value: string }>;
    };
    expect(rendered.items.map((item) => item.value)).toEqual([
      "general",
      "secrets",
      "instance-profile",
    ]);

    await asyncAct(async () => {
      root.unmount();
    });
  });
});
