import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyPluginAvailability } from "@paperclipai/shared";
import { CompanySettings } from "./CompanySettings";
import { pluginsApi } from "@/api/plugins";

if (!React.act) {
  (React as Record<string, unknown>).act = (cb: () => unknown) => cb();
}

const currentCompanyState = {
  companies: [
    {
      id: "comp-1",
      name: "Test Co",
      description: null,
      brandColor: null,
      status: "active",
      requireBoardApprovalForNewAgents: false,
    },
    {
      id: "comp-2",
      name: "Other Co",
      description: null,
      brandColor: null,
      status: "active",
      requireBoardApprovalForNewAgents: false,
    },
  ],
  selectedCompanyId: "comp-1",
  selectedCompany: {
    id: "comp-1",
    name: "Test Co",
    description: null,
    brandColor: null,
    status: "active",
    requireBoardApprovalForNewAgents: false,
  },
  setSelectedCompanyId: vi.fn(),
};

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => currentCompanyState,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/api/companies", () => ({
  companiesApi: {
    update: vi.fn(),
    archive: vi.fn(),
  },
}));

vi.mock("@/api/access", () => ({
  accessApi: {
    createCompanyInvite: vi.fn(),
    getInviteOnboarding: vi.fn(),
  },
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    listForCompany: vi.fn(),
    saveForCompany: vi.fn(),
  },
}));

vi.mock("../components/CompanyPatternIcon", () => ({
  CompanyPatternIcon: () => <div data-testid="company-pattern-icon" />,
}));

vi.mock("../components/agent-config-primitives", () => ({
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <label>
      <span>{label}</span>
      {children}
    </label>
  ),
  ToggleField: ({
    label,
    checked,
    disabled,
    onChange,
  }: {
    label: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <label>
      <span>{label}</span>
      <input
        aria-label={label}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  ),
  HintIcon: () => <span data-testid="hint-icon" />,
}));

function makeCompanyPlugin(
  overrides: Partial<CompanyPluginAvailability> = {},
): CompanyPluginAvailability {
  return {
    companyId: "comp-1",
    pluginId: "plug-1",
    pluginKey: "acme.test",
    pluginDisplayName: "Test Plugin",
    pluginStatus: "ready",
    available: true,
    settingsJson: {},
    lastError: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function renderComponent() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <CompanySettings />
    </QueryClientProvider>,
  );
}

describe("CompanySettings plugin availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentCompanyState.selectedCompanyId = "comp-1";
    currentCompanyState.selectedCompany = currentCompanyState.companies[0]!;
    (pluginsApi.listForCompany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (pluginsApi.saveForCompany as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCompanyPlugin(),
    );
  });

  afterEach(() => {
    cleanup();
  });

  it("renders plugins that are enabled by default for the selected company", async () => {
    (pluginsApi.listForCompany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeCompanyPlugin({
        available: true,
        pluginDisplayName: "Default Enabled Plugin",
      }),
    ]);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Default Enabled Plugin")).toBeTruthy();
    });

    expect(pluginsApi.listForCompany).toHaveBeenCalledWith("comp-1");
    expect((screen.getByLabelText("Enabled") as HTMLInputElement).checked).toBe(true);
  });

  it("sends a disable update when turning off an enabled plugin", async () => {
    (pluginsApi.listForCompany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeCompanyPlugin({ available: true }),
    ]);

    renderComponent();

    const toggle = await screen.findByLabelText("Enabled");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(pluginsApi.saveForCompany).toHaveBeenCalledWith("comp-1", "plug-1", {
        available: false,
      });
    });
  });

  it("sends an enable update when turning on a disabled plugin", async () => {
    (pluginsApi.listForCompany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeCompanyPlugin({
        pluginId: "plug-2",
        pluginKey: "acme.disabled",
        pluginDisplayName: "Disabled Plugin",
        available: false,
      }),
    ]);

    renderComponent();

    const toggle = await screen.findByLabelText("Disabled");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(pluginsApi.saveForCompany).toHaveBeenCalledWith("comp-1", "plug-2", {
        available: true,
      });
    });
  });

  it("keeps plugin availability requests scoped to the selected company", async () => {
    currentCompanyState.selectedCompanyId = "comp-2";
    currentCompanyState.selectedCompany = currentCompanyState.companies[1]!;
    (pluginsApi.listForCompany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeCompanyPlugin({
        companyId: "comp-2",
        pluginId: "plug-22",
        pluginKey: "acme.other-company",
        pluginDisplayName: "Other Company Plugin",
        available: false,
      }),
    ]);

    renderComponent();

    const toggle = await screen.findByLabelText("Disabled");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(pluginsApi.listForCompany).toHaveBeenCalledWith("comp-2");
      expect(pluginsApi.saveForCompany).toHaveBeenCalledWith("comp-2", "plug-22", {
        available: true,
      });
    });
  });

  it("disables the company toggle when the plugin is not globally ready", async () => {
    (pluginsApi.listForCompany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeCompanyPlugin({
        pluginStatus: "installed",
        pluginDisplayName: "Needs Global Enable",
        available: false,
      }),
    ]);

    renderComponent();

    const toggle = await screen.findByLabelText("Disabled");

    expect(toggle).toBeTruthy();
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/not globally ready/i)).toBeTruthy();

    fireEvent.click(toggle);

    expect(pluginsApi.saveForCompany).not.toHaveBeenCalled();
  });
});
