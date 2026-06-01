// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySettingsNav, getCompanySettingsTab } from "./CompanySettingsNav";

let currentPathname = "/company/settings";
const navigateMock = vi.hoisted(() => vi.fn());
const pageTabBarMock = vi.hoisted(() => vi.fn());

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

describe("CompanySettingsNav", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentPathname = "/company/settings";
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("maps company settings routes to the expected shared tab value", () => {
    expect(getCompanySettingsTab("/company/settings")).toBe("general");
    expect(getCompanySettingsTab("/PAP/company/settings")).toBe("general");
    expect(getCompanySettingsTab("/company/settings/environments")).toBe("environments");
    expect(getCompanySettingsTab("/PAP/company/settings/environments")).toBe("environments");
    expect(getCompanySettingsTab("/company/settings/cloud-upstream")).toBe("cloud-upstream");
    expect(getCompanySettingsTab("/company/settings/members")).toBe("members");
    expect(getCompanySettingsTab("/PAP/company/settings/members")).toBe("members");
    expect(getCompanySettingsTab("/company/settings/access")).toBe("members");
    expect(getCompanySettingsTab("/PAP/company/settings/access")).toBe("members");
    expect(getCompanySettingsTab("/company/settings/invites")).toBe("invites");
    expect(getCompanySettingsTab("/PAP/company/settings/secrets")).toBe("secrets");
  });

  it("renders the active tab and navigates when a different tab is selected", async () => {
    currentPathname = "/PAP/company/settings/members";
    const root = createRoot(container);

    await act(async () => {
      root.render(<CompanySettingsNav />);
    });

    expect(container.textContent).toContain("members");
    expect(pageTabBarMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "members",
        items: [
          { value: "general", label: "General" },
          { value: "environments", label: "Environments" },
          { value: "cloud-upstream", label: "Cloud upstream" },
          { value: "members", label: "Members" },
          { value: "invites", label: "Invites" },
          { value: "secrets", label: "Secrets" },
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
});
