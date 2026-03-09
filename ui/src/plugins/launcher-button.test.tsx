import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginLauncherDeclaration } from "@paperclipai/shared";

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    listUiContributions: vi.fn(),
    bridgePerformAction: vi.fn(),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: null,
    selectedCompanyId: "company-1",
  }),
}));

const navigateMock = vi.fn();

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ key: "loc-1", pathname: "/" }),
}));

import { pluginsApi, type PluginUiContribution } from "@/api/plugins";
import { PluginLauncherButton, PluginLauncherProvider } from "./launchers";
import { registerPluginReactComponent, _resetPluginModuleLoader } from "./slots";

if (!React.act) {
  (React as Record<string, unknown>).act = (cb: () => unknown) => cb();
}

function makeContribution(
  launcher: PluginLauncherDeclaration,
): PluginUiContribution {
  return {
    pluginId: "plugin-1",
    pluginKey: "acme.tools",
    displayName: "Acme Tools",
    version: "1.0.0",
    uiEntryFile: "index.js",
    slots: [],
    launchers: [launcher],
  };
}

function renderLauncherButton(
  launcher: PluginLauncherDeclaration,
  options?: {
    onActivated?: () => void;
  },
) {
  const contribution = makeContribution(launcher);
  return render(
    <PluginLauncherProvider>
      <PluginLauncherButton
        launcher={{
          ...launcher,
          pluginId: contribution.pluginId,
          pluginKey: contribution.pluginKey,
          pluginDisplayName: contribution.displayName,
          pluginVersion: contribution.version,
          uiEntryFile: contribution.uiEntryFile,
        }}
        contribution={contribution}
        context={{ companyId: "company-1", entityId: "issue-1", entityType: "issue" }}
        onActivated={options?.onActivated}
      />
    </PluginLauncherProvider>,
  );
}

describe("PluginLauncherButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pluginsApi.bridgePerformAction).mockResolvedValue({ data: { ok: true } });
  });

  afterEach(() => {
    cleanup();
    _resetPluginModuleLoader();
    document.body.innerHTML = "";
  });

  it("runs the activation cleanup hook before performAction launchers execute", async () => {
    const onActivated = vi.fn();

    renderLauncherButton(
      {
        id: "issue-refresh",
        displayName: "Refresh",
        placementZone: "contextMenuItem",
        entityTypes: ["issue"],
        action: {
          type: "performAction",
          target: "refreshUsage",
          params: { force: true },
        },
      },
      { onActivated },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(pluginsApi.bridgePerformAction).toHaveBeenCalledWith(
        "plugin-1",
        "refreshUsage",
        { force: true },
        "company-1",
      );
    });

    expect(onActivated).toHaveBeenCalledTimes(1);
    expect(onActivated.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(pluginsApi.bridgePerformAction).mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(pluginsApi.listUiContributions).not.toHaveBeenCalled();
  });

  it("uses the provided contribution metadata to open modal launchers without refetching contributions", async () => {
    const onActivated = vi.fn();

    registerPluginReactComponent("acme.tools", "UsageModal", function UsageModal() {
      return <div>Claude usage modal</div>;
    });

    renderLauncherButton(
      {
        id: "claude-usage",
        displayName: "Claude Usage",
        placementZone: "contextMenuItem",
        entityTypes: ["issue"],
        action: {
          type: "openModal",
          target: "UsageModal",
        },
        render: {
          environment: "hostOverlay",
          bounds: "compact",
        },
      },
      { onActivated },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Claude Usage" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(screen.getByText("Claude usage modal")).toBeTruthy();
    });

    expect(onActivated).toHaveBeenCalledTimes(1);
    expect(pluginsApi.listUiContributions).not.toHaveBeenCalled();
  });

  it("runs the activation cleanup hook for navigate launchers before routing away", async () => {
    const onActivated = vi.fn();

    renderLauncherButton(
      {
        id: "issue-docs",
        displayName: "Docs",
        placementZone: "contextMenuItem",
        entityTypes: ["issue"],
        action: {
          type: "navigate",
          target: "/projects/proj-1/issues/issue-1/docs",
        },
      },
      { onActivated },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Docs" }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith("/projects/proj-1/issues/issue-1/docs");
    });

    expect(onActivated).toHaveBeenCalledTimes(1);
    expect(onActivated.mock.invocationCallOrder[0]).toBeLessThan(
      navigateMock.mock.invocationCallOrder[0] ?? Infinity,
    );
  });
});
