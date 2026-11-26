// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySettingsNav, getCompanySettingsTab } from "./CompanySettingsNav";

const mockNavigate = vi.fn();
const mockUseLocation = vi.fn();
const mockUseHiddenSettings = vi.fn();
const mockUseCloudInstance = vi.fn();
const mockUseCompany = vi.fn();
const mockUsePluginSlots = vi.fn();

vi.mock("@/lib/router", () => ({
  useLocation: () => mockUseLocation(),
  useNavigate: () => mockNavigate,
}));

vi.mock("@/hooks/useHiddenSettings", () => ({
  useHiddenSettings: () => mockUseHiddenSettings(),
}));

vi.mock("@/hooks/useCloudInstance", () => ({
  useCloudInstance: () => mockUseCloudInstance(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => mockUseCompany(),
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: (...args: unknown[]) => mockUsePluginSlots(...args),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: true }),
}));

describe("CompanySettingsNav", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockUseLocation.mockReturnValue({ pathname: "/PAP/company/settings" });
    mockUseHiddenSettings.mockReturnValue({ hidden: new Set<string>() });
    mockUseCloudInstance.mockReturnValue(false);
    mockUseCompany.mockReturnValue({ selectedCompanyId: "company-1" });
    mockUsePluginSlots.mockReturnValue({
      slots: [
        {
          id: "billing-settings",
          pluginKey: "paperclip.billing",
          displayName: "Billing",
          routePath: "billing",
        },
      ],
    });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("includes companySettingsPluginSlots and navigates to their routes", () => {
    root = createRoot(container);
    flushSync(() => {
      root!.render(<CompanySettingsNav />);
    });

    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    const optionTexts = Array.from(select.options).map((opt) => opt.textContent);
    expect(optionTexts).toContain("Billing");
    expect(optionTexts).toContain("Export");

    const billingOption = Array.from(select.options).find((opt) => opt.textContent === "Billing");
    expect(billingOption).toBeDefined();

    flushSync(() => {
      select.value = billingOption!.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(mockNavigate).toHaveBeenCalledWith("/company/settings/billing");
  });

  it("navigates Export to /company/export (not /company/settings/export)", () => {
    root = createRoot(container);
    flushSync(() => {
      root!.render(<CompanySettingsNav />);
    });

    const select = container.querySelector("select") as HTMLSelectElement;
    flushSync(() => {
      select.value = "export";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(mockNavigate).toHaveBeenCalledWith("/company/export");
  });

  it("resolves plugin settings routes to the matching plugin tab without built-in prefix collisions", () => {
    const slots = [
      {
        id: "billing-settings",
        pluginKey: "paperclip.billing",
        displayName: "Billing",
        routePath: "billing",
      },
      {
        id: "secrets-manager",
        pluginKey: "acme.vault",
        displayName: "Secrets Manager",
        routePath: "secrets-manager",
      },
    ];
    expect(getCompanySettingsTab("/PAP/company/settings/billing", slots)).toBe(
      "plugin:paperclip.billing:billing-settings",
    );
    expect(getCompanySettingsTab("/PAP/company/settings/secrets-manager", slots)).toBe(
      "plugin:acme.vault:secrets-manager",
    );
    expect(getCompanySettingsTab("/PAP/company/settings/secrets", slots)).toBe("secrets");
    expect(getCompanySettingsTab("/PAP/company/export/files/agent.md", slots)).toBe("export");
  });
});
