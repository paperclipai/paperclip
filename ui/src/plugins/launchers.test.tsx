import * as React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    listUiContributions: vi.fn(),
    bridgeGetData: vi.fn(),
    bridgePerformAction: vi.fn(),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: null,
    selectedCompanyId: "company-1",
  }),
}));

import { useQuery } from "@tanstack/react-query";
import { pluginsApi } from "@/api/plugins";
import { useHostContext, usePluginAction } from "./bridge";
import { PluginLauncherOutlet, PluginLauncherProvider } from "./launchers";
import {
  registerPluginReactComponent,
  _resetPluginModuleLoader,
} from "./slots";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MockContribution = {
  pluginId: string;
  pluginKey: string;
  displayName: string;
  version: string;
  uiEntryFile: string;
  slots: [];
  launchers: Array<Record<string, unknown>>;
};

function renderNode(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(node);
  });
  return {
    container,
    unmount: () =>
      flushSync(() => {
        root.unmount();
        container.remove();
      }),
  };
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mockUseQuery(data: MockContribution[], error: unknown = null) {
  vi.mocked(useQuery).mockReturnValue({
    data,
    isLoading: false,
    error,
  } as unknown as ReturnType<typeof useQuery>);
}

describe("plugin launcher runtime", () => {
  beforeEach(() => {
    vi.mocked(pluginsApi.listUiContributions).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    _resetPluginModuleLoader();
    document.body.innerHTML = "";
  });

  it("filters launchers by placement zone", () => {
    const contributions: MockContribution[] = [
      {
        pluginId: "plugin-1",
        pluginKey: "acme.tools",
        displayName: "Acme Tools",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [],
        launchers: [
          {
            id: "toolbar-sync",
            displayName: "Sync",
            placementZone: "toolbarButton",
            action: { type: "openModal", target: "SyncModal" },
            render: { environment: "hostOverlay", bounds: "default" },
          },
          {
            id: "project-files",
            displayName: "Files",
            placementZone: "projectSidebarItem",
            entityTypes: ["project"],
            action: { type: "openModal", target: "FilesModal" },
            render: { environment: "hostOverlay", bounds: "default" },
          },
        ],
      },
    ];

    mockUseQuery(contributions);

    const view = renderNode(
      <MemoryRouter>
        <PluginLauncherProvider>
          <PluginLauncherOutlet
            placementZones={["toolbarButton"]}
            context={{ companyId: "company-1" }}
          />
        </PluginLauncherProvider>
      </MemoryRouter>,
    );

    expect(view.container.textContent).toContain("Sync");
    expect(view.container.textContent).not.toContain("Files");
    view.unmount();
  });

  it("filters entity-scoped launchers by entity type", () => {
    const contributions: MockContribution[] = [
      {
        pluginId: "plugin-1",
        pluginKey: "acme.tools",
        displayName: "Acme Tools",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [],
        launchers: [
          {
            id: "project-files",
            displayName: "Files",
            placementZone: "detailTab",
            entityTypes: ["project"],
            action: { type: "openModal", target: "FilesModal" },
            render: { environment: "hostOverlay", bounds: "default" },
          },
          {
            id: "issue-audit",
            displayName: "Audit",
            placementZone: "detailTab",
            entityTypes: ["issue"],
            action: { type: "openModal", target: "AuditModal" },
            render: { environment: "hostOverlay", bounds: "default" },
          },
        ],
      },
    ];

    mockUseQuery(contributions);

    const view = renderNode(
      <MemoryRouter>
        <PluginLauncherProvider>
          <PluginLauncherOutlet
            placementZones={["detailTab"]}
            entityType="project"
            context={{ companyId: "company-1", entityId: "project-1", entityType: "project" }}
          />
        </PluginLauncherProvider>
      </MemoryRouter>,
    );

    expect(view.container.textContent).toContain("Files");
    expect(view.container.textContent).not.toContain("Audit");
    view.unmount();
  });

  it("renders launchers in placement order and uses placement-specific trigger styles", () => {
    const contributions: MockContribution[] = [
      {
        pluginId: "plugin-2",
        pluginKey: "beta.tools",
        displayName: "Beta Tools",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [],
        launchers: [
          {
            id: "beta-files",
            displayName: "Beta Files",
            placementZone: "projectSidebarItem",
            entityTypes: ["project"],
            order: 5,
            action: { type: "navigate", target: "/beta/files" },
          },
        ],
      },
      {
        pluginId: "plugin-1",
        pluginKey: "acme.tools",
        displayName: "Acme Tools",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [],
        launchers: [
          {
            id: "alpha-docs",
            displayName: "Alpha Docs",
            placementZone: "projectSidebarItem",
            entityTypes: ["project"],
            order: 5,
            action: { type: "navigate", target: "/alpha/docs" },
          },
          {
            id: "zeta-files",
            displayName: "Zeta Files",
            placementZone: "projectSidebarItem",
            entityTypes: ["project"],
            order: 20,
            action: { type: "navigate", target: "/zeta/files" },
          },
        ],
      },
    ];

    mockUseQuery(contributions);

    const view = renderNode(
      <MemoryRouter>
        <PluginLauncherProvider>
          <PluginLauncherOutlet
            placementZones={["projectSidebarItem"]}
            entityType="project"
            context={{ companyId: "company-1", entityId: "project-1", entityType: "project" }}
          />
        </PluginLauncherProvider>
      </MemoryRouter>,
    );

    const buttons = Array.from(view.container.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Alpha Docs",
      "Beta Files",
      "Zeta Files",
    ]);
    expect(buttons[0]?.className).toContain("justify-start");
    expect(buttons[0]?.className).toContain("text-[12px]");
    view.unmount();
  });

  it("opens modal launchers, lets the plugin request bounds, emits close lifecycle events, and restores focus", async () => {
    const contributions: MockContribution[] = [
      {
        pluginId: "plugin-1",
        pluginKey: "acme.tools",
        displayName: "Acme Tools",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [],
        launchers: [
          {
            id: "toolbar-sync",
            displayName: "Sync",
            placementZone: "toolbarButton",
            action: { type: "openModal", target: "SyncModal" },
            render: { environment: "hostOverlay", bounds: "compact" },
          },
        ],
      },
    ];

    const beforeClose = vi.fn();
    const onClose = vi.fn();
    vi.mocked(pluginsApi.bridgePerformAction).mockResolvedValue({ data: { ok: true } });

    registerPluginReactComponent("acme.tools", "SyncModal", function SyncModal() {
      const context = useHostContext();
      const submit = usePluginAction("submit");

      React.useEffect(() => {
        const removeBefore = context.renderEnvironment?.closeLifecycle?.onBeforeClose?.(beforeClose);
        const removeClose = context.renderEnvironment?.closeLifecycle?.onClose?.(onClose);
        return () => {
          removeBefore?.();
          removeClose?.();
        };
      }, [context]);

      return (
        <div>
          <p>Modal body</p>
          <p data-testid="bounds">{context.renderEnvironment?.bounds}</p>
          <button
            type="button"
            onClick={() => void context.renderEnvironment?.requestModalBounds?.({ bounds: "wide" })}
          >
            Resize
          </button>
          <button
            type="button"
            onClick={() => void submit({ intent: "save" })}
          >
            Submit
          </button>
        </div>
      );
    });

    mockUseQuery(contributions);
    vi.mocked(pluginsApi.listUiContributions).mockResolvedValue(contributions as never);

    const view = renderNode(
      <MemoryRouter>
        <PluginLauncherProvider>
          <PluginLauncherOutlet
            placementZones={["toolbarButton"]}
            context={{ companyId: "company-1" }}
          />
        </PluginLauncherProvider>
      </MemoryRouter>,
    );

    const trigger = view.container.querySelector("button");
    expect(trigger).not.toBeNull();

    trigger!.focus();
    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushEffects();

    const modal = document.querySelector('[role="dialog"]') as HTMLDivElement | null;
    expect(modal?.textContent).toContain("Modal body");
    expect(modal?.style.width).toContain("28rem");

    const resizeButton = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Resize"),
    );
    expect(resizeButton).not.toBeUndefined();

    resizeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushEffects();

    const resizedModal = document.querySelector('[role="dialog"]') as HTMLDivElement | null;
    expect(resizedModal?.style.width).toContain("64rem");
    expect(document.querySelector('[data-testid="bounds"]')?.textContent).toBe("wide");

    const submitButton = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Submit"),
    );
    expect(submitButton).not.toBeUndefined();

    submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushEffects();

    expect(pluginsApi.bridgePerformAction).toHaveBeenCalledWith(
      "plugin-1",
      "submit",
      { intent: "save" },
      "company-1",
      {
        environment: "hostOverlay",
        launcherId: "toolbar-sync",
        bounds: "wide",
      },
    );

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushEffects();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(beforeClose).toHaveBeenCalledWith(expect.objectContaining({ reason: "escapeKey" }));
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: "escapeKey" }));
    expect(document.activeElement).toBe(trigger);
    expect(pluginsApi.listUiContributions).not.toHaveBeenCalled();
    view.unmount();
  });

  it("supports close flow via backdrop and close button", async () => {
    const contributions: MockContribution[] = [
      {
        pluginId: "plugin-1",
        pluginKey: "acme.tools",
        displayName: "Acme Tools",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [],
        launchers: [
          {
            id: "toolbar-sync",
            displayName: "Sync",
            placementZone: "toolbarButton",
            action: { type: "openModal", target: "SyncModal" },
            render: { environment: "hostOverlay", bounds: "default" },
          },
        ],
      },
    ];

    const beforeClose = vi.fn();
    const onClose = vi.fn();

    registerPluginReactComponent("acme.tools", "SyncModal", function SyncModal() {
      const context = useHostContext();

      React.useEffect(() => {
        const removeBefore = context.renderEnvironment?.closeLifecycle?.onBeforeClose?.(beforeClose);
        const removeClose = context.renderEnvironment?.closeLifecycle?.onClose?.(onClose);
        return () => {
          removeBefore?.();
          removeClose?.();
        };
      }, [context]);

      return <p>Modal body</p>;
    });

    mockUseQuery(contributions);
    vi.mocked(pluginsApi.listUiContributions).mockResolvedValue(contributions as never);

    const view = renderNode(
      <MemoryRouter>
        <PluginLauncherProvider>
          <PluginLauncherOutlet
            placementZones={["toolbarButton"]}
            context={{ companyId: "company-1" }}
          />
        </PluginLauncherProvider>
      </MemoryRouter>,
    );

    const trigger = view.container.querySelector("button");
    expect(trigger).not.toBeNull();

    trigger!.focus();
    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushEffects();

    const backdrop = document.querySelector('[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    backdrop!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flushEffects();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(beforeClose).toHaveBeenCalledWith(expect.objectContaining({ reason: "backdrop" }));
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: "backdrop" }));
    expect(document.activeElement).toBe(trigger);

    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushEffects();

    const closeButton = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Close"),
    );
    expect(closeButton).not.toBeUndefined();

    closeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushEffects();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(beforeClose).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "programmatic" }));
    expect(onClose).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "programmatic" }));
    expect(document.activeElement).toBe(trigger);
    view.unmount();
  });

  it("enforces host bounds presets when plugins request modal resizing", async () => {
    const contributions: MockContribution[] = [
      {
        pluginId: "plugin-1",
        pluginKey: "acme.tools",
        displayName: "Acme Tools",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [],
        launchers: [
          {
            id: "toolbar-sync",
            displayName: "Sync",
            placementZone: "toolbarButton",
            action: { type: "openModal", target: "SyncModal" },
            render: { environment: "hostOverlay", bounds: "compact" },
          },
        ],
      },
    ];

    registerPluginReactComponent("acme.tools", "SyncModal", function SyncModal() {
      const context = useHostContext();

      return (
        <div>
          <p data-testid="bounds">{context.renderEnvironment?.bounds}</p>
          <button
            type="button"
            onClick={() =>
              void context.renderEnvironment?.requestModalBounds?.({
                bounds: "full",
                width: 123,
                height: 456,
                minWidth: 100,
                minHeight: 200,
                maxWidth: 999,
                maxHeight: 888,
              })
            }
          >
            Resize full
          </button>
        </div>
      );
    });

    mockUseQuery(contributions);
    vi.mocked(pluginsApi.listUiContributions).mockResolvedValue(contributions as never);

    const view = renderNode(
      <MemoryRouter>
        <PluginLauncherProvider>
          <PluginLauncherOutlet
            placementZones={["toolbarButton"]}
            context={{ companyId: "company-1" }}
          />
        </PluginLauncherProvider>
      </MemoryRouter>,
    );

    const trigger = view.container.querySelector("button");
    expect(trigger).not.toBeNull();

    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushEffects();

    const resizeButton = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Resize full"),
    );
    expect(resizeButton).not.toBeUndefined();

    resizeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushEffects();

    const modal = document.querySelector('[role="dialog"]') as HTMLDivElement | null;
    expect(modal?.style.width).toBe("calc(100vw - 2rem)");
    expect(modal?.style.height).toBe("calc(100vh - 2rem)");
    expect(modal?.style.width).not.toBe("123px");
    expect(modal?.style.height).not.toBe("456px");
    expect(document.querySelector('[data-testid="bounds"]')?.textContent).toBe("full");
    view.unmount();
  });

  it("ignores unsupported modal bounds requests", async () => {
    const contributions: MockContribution[] = [
      {
        pluginId: "plugin-1",
        pluginKey: "acme.tools",
        displayName: "Acme Tools",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [],
        launchers: [
          {
            id: "toolbar-sync",
            displayName: "Sync",
            placementZone: "toolbarButton",
            action: { type: "openModal", target: "SyncModal" },
            render: { environment: "hostOverlay", bounds: "compact" },
          },
        ],
      },
    ];

    registerPluginReactComponent("acme.tools", "SyncModal", function SyncModal() {
      const context = useHostContext();

      return (
        <div>
          <p data-testid="bounds">{context.renderEnvironment?.bounds}</p>
          <button
            type="button"
            onClick={() =>
              void context.renderEnvironment?.requestModalBounds?.({
                bounds: "oversized" as unknown as "compact",
              })
            }
          >
            Resize invalid
          </button>
        </div>
      );
    });

    mockUseQuery(contributions);

    const view = renderNode(
      <MemoryRouter>
        <PluginLauncherProvider>
          <PluginLauncherOutlet
            placementZones={["toolbarButton"]}
            context={{ companyId: "company-1" }}
          />
        </PluginLauncherProvider>
      </MemoryRouter>,
    );

    const trigger = view.container.querySelector("button");
    expect(trigger).not.toBeNull();

    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushEffects();

    const resizeButton = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Resize invalid"),
    );
    expect(resizeButton).not.toBeUndefined();

    resizeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushEffects();

    const modal = document.querySelector('[role="dialog"]') as HTMLDivElement | null;
    expect(modal?.style.width).toContain("28rem");
    expect(document.querySelector('[data-testid="bounds"]')?.textContent).toBe("compact");
    view.unmount();
  });

  it("applies dialog accessibility semantics and traps focus within the topmost overlay", async () => {
    const contributions: MockContribution[] = [
      {
        pluginId: "plugin-1",
        pluginKey: "acme.tools",
        displayName: "Acme Tools",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [],
        launchers: [
          {
            id: "toolbar-sync",
            displayName: "Sync",
            placementZone: "toolbarButton",
            action: { type: "openModal", target: "AccessibleModal" },
            render: { environment: "hostOverlay", bounds: "default" },
          },
        ],
      },
    ];

    registerPluginReactComponent("acme.tools", "AccessibleModal", function AccessibleModal() {
      return (
        <div>
          <button type="button">First action</button>
          <button type="button">Last action</button>
        </div>
      );
    });

    mockUseQuery(contributions);
    vi.mocked(pluginsApi.listUiContributions).mockResolvedValue(contributions as never);

    const view = renderNode(
      <MemoryRouter>
        <PluginLauncherProvider>
          <PluginLauncherOutlet
            placementZones={["toolbarButton"]}
            context={{ companyId: "company-1" }}
          />
        </PluginLauncherProvider>
      </MemoryRouter>,
    );

    const trigger = view.container.querySelector("button");
    expect(trigger).not.toBeNull();

    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushEffects();

    const dialog = document.querySelector('[role="dialog"]') as HTMLDivElement | null;
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");

    const titleId = dialog?.getAttribute("aria-labelledby");
    expect(titleId).toBeTruthy();
    const title = titleId ? document.getElementById(titleId) : null;
    expect(title?.textContent).toBe("Sync");

    const closeButton = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Close"),
    );
    const lastActionButton = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Last action"),
    );
    expect(closeButton).toBeDefined();
    expect(lastActionButton).toBeDefined();

    closeButton!.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    await flushEffects();
    expect(document.activeElement?.textContent).toBe("Last action");

    lastActionButton!.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    await flushEffects();
    expect(document.activeElement?.textContent).toBe("Close");

    view.unmount();
  });

  it("closes only the topmost launcher when overlays are stacked", async () => {
    const contributions: MockContribution[] = [
      {
        pluginId: "plugin-1",
        pluginKey: "acme.tools",
        displayName: "Acme Tools",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [],
        launchers: [
          {
            id: "toolbar-sync",
            displayName: "Sync",
            placementZone: "toolbarButton",
            action: { type: "openModal", target: "SyncModal" },
            render: { environment: "hostOverlay", bounds: "compact" },
          },
        ],
      },
    ];

    registerPluginReactComponent("acme.tools", "SyncModal", function SyncModal() {
      const context = useHostContext();
      return <div>{context.renderEnvironment?.launcherId}</div>;
    });

    mockUseQuery(contributions);
    vi.mocked(pluginsApi.listUiContributions).mockResolvedValue(contributions as never);

    const view = renderNode(
      <MemoryRouter>
        <PluginLauncherProvider>
          <PluginLauncherOutlet
            placementZones={["toolbarButton"]}
            context={{ companyId: "company-1" }}
          />
        </PluginLauncherProvider>
      </MemoryRouter>,
    );

    const trigger = view.container.querySelector("button");
    expect(trigger).not.toBeNull();

    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushEffects();

    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushEffects();

    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    view.unmount();
  });

  it("keeps modal bounds isolated across stacked launcher instances", async () => {
    const contributions: MockContribution[] = [
      {
        pluginId: "plugin-1",
        pluginKey: "acme.tools",
        displayName: "Acme Tools",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [],
        launchers: [
          {
            id: "toolbar-sync",
            displayName: "Sync",
            placementZone: "toolbarButton",
            action: { type: "openModal", target: "SyncModal" },
            render: { environment: "hostOverlay", bounds: "compact" },
          },
        ],
      },
    ];

    registerPluginReactComponent("acme.tools", "SyncModal", function SyncModal() {
      const context = useHostContext();
      return (
        <div>
          <p data-testid="bounds">{context.renderEnvironment?.bounds}</p>
          <button
            type="button"
            onClick={() => void context.renderEnvironment?.requestModalBounds?.({ bounds: "wide" })}
          >
            Resize
          </button>
        </div>
      );
    });

    mockUseQuery(contributions);
    vi.mocked(pluginsApi.listUiContributions).mockResolvedValue(contributions as never);

    const view = renderNode(
      <MemoryRouter>
        <PluginLauncherProvider>
          <PluginLauncherOutlet
            placementZones={["toolbarButton"]}
            context={{ companyId: "company-1" }}
          />
        </PluginLauncherProvider>
      </MemoryRouter>,
    );

    const trigger = view.container.querySelector("button");
    expect(trigger).not.toBeNull();

    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushEffects();

    let dialogs = Array.from(document.querySelectorAll('[role="dialog"]')) as HTMLDivElement[];
    expect(dialogs).toHaveLength(2);
    expect(dialogs[0]?.style.width).toContain("28rem");
    expect(dialogs[1]?.style.width).toContain("28rem");

    const resizeButtons = Array.from(document.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes("Resize"),
    );
    expect(resizeButtons).toHaveLength(2);

    resizeButtons[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushEffects();

    dialogs = Array.from(document.querySelectorAll('[role="dialog"]')) as HTMLDivElement[];
    const bounds = Array.from(document.querySelectorAll('[data-testid="bounds"]')).map((node) => node.textContent);
    expect(bounds).toEqual(["compact", "wide"]);
    expect(dialogs[0]?.style.width).toContain("28rem");
    expect(dialogs[1]?.style.width).toContain("64rem");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushEffects();

    dialogs = Array.from(document.querySelectorAll('[role="dialog"]')) as HTMLDivElement[];
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.style.width).toContain("28rem");
    expect(document.querySelector('[data-testid="bounds"]')?.textContent).toBe("compact");
    view.unmount();
  });
});
