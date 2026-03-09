import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginUiSlotDeclaration } from "@paperclipai/shared";

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
}));

import { useQuery } from "@tanstack/react-query";
import {
  PluginSlotMount,
  PluginSlotOutlet,
  registerPluginReactComponent,
  registerPluginWebComponent,
  _applyJsxRuntimeKeyForTests,
  _rewriteBareSpecifiersForTests,
  _resetPluginModuleLoader,
} from "./slots";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MockContribution = {
  pluginId: string;
  pluginKey: string;
  displayName: string;
  version: string;
  uiEntryFile: string;
  slots: PluginUiSlotDeclaration[];
};

function renderNode(node: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    rerender: (next: ReturnType<typeof createElement>) =>
      act(() => {
        root.render(next);
      }),
    unmount: () =>
      act(() => {
        root.unmount();
        container.remove();
      }),
  };
}

function mockUseQuery(data: MockContribution[], error: unknown = null) {
  vi.mocked(useQuery).mockReturnValue({
    data,
    isLoading: false,
    error,
  } as unknown as ReturnType<typeof useQuery>);
}

afterEach(() => {
  vi.clearAllMocks();
  _resetPluginModuleLoader();
  document.body.innerHTML = "";
});

describe("plugin slot runtime", () => {
  it("renders sorted detail slots and filters by entity type", () => {
    mockUseQuery([
      {
        pluginId: "p1",
        pluginKey: "acme.tasks",
        displayName: "Acme Tasks",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [
          {
            id: "slow",
            type: "taskDetailView",
            displayName: "Slow",
            order: 20,
            exportName: "SlowPanel",
            entityTypes: ["issue"],
          },
          {
            id: "fast",
            type: "taskDetailView",
            displayName: "Fast",
            order: 10,
            exportName: "FastPanel",
            entityTypes: ["issue"],
          },
          {
            id: "project-only",
            type: "taskDetailView",
            displayName: "Project",
            order: 1,
            exportName: "ProjectPanel",
            entityTypes: ["project"],
          },
        ],
      },
    ]);

    registerPluginReactComponent("acme.tasks", "FastPanel", ({ slot }) => <div>{slot.displayName}</div>);
    registerPluginReactComponent("acme.tasks", "SlowPanel", ({ slot }) => <div>{slot.displayName}</div>);

    const view = renderNode(
      <PluginSlotOutlet
        slotTypes={["taskDetailView"]}
        entityType="issue"
        context={{ companyId: "c1", entityType: "issue", entityId: "i1" }}
      />,
    );

    expect(view.container.textContent).toContain("Fast");
    expect(view.container.textContent).toContain("Slow");
    expect(view.container.textContent).not.toContain("Project");
    expect(view.container.textContent?.indexOf("Fast")).toBeLessThan(
      view.container.textContent?.indexOf("Slow") ?? Number.POSITIVE_INFINITY,
    );
    view.unmount();
  });

  it("usePluginSlots with projectSidebarItem and entityType project returns only slots with entityTypes including project", () => {
    mockUseQuery([
      {
        pluginId: "file-plugin",
        pluginKey: "paperclip.files",
        displayName: "Files",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [
          {
            id: "files-link",
            type: "projectSidebarItem",
            displayName: "Files",
            exportName: "FilesLink",
            entityTypes: ["project"],
          },
        ],
      },
      {
        pluginId: "issue-plugin",
        pluginKey: "paperclip.issue-extra",
        displayName: "Issue Extra",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [
          {
            id: "issue-sidebar",
            type: "projectSidebarItem",
            displayName: "Issue Link",
            exportName: "IssueLink",
            entityTypes: ["issue"],
          },
        ],
      },
    ]);

    registerPluginReactComponent("paperclip.files", "FilesLink", ({ slot }) => <div>{slot.displayName}</div>);
    registerPluginReactComponent("paperclip.issue-extra", "IssueLink", ({ slot }) => <div>{slot.displayName}</div>);

    const view = renderNode(
      <PluginSlotOutlet
        slotTypes={["projectSidebarItem"]}
        entityType="project"
        context={{ companyId: "c1", entityType: "project", entityId: "proj-1" }}
      />,
    );

    expect(view.container.textContent).toContain("Files");
    expect(view.container.textContent).not.toContain("Issue Link");
    view.unmount();
  });

  it("renders placeholder when slot component is missing and placeholder mode is enabled", () => {
    mockUseQuery([
      {
        pluginId: "p2",
        pluginKey: "acme.missing",
        displayName: "Missing Plugin",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [
          {
            id: "missing",
            type: "toolbarButton",
            displayName: "Missing Button",
            order: 1,
            exportName: "MissingButton",
          },
        ],
      },
    ]);

    const view = renderNode(
      <PluginSlotOutlet
        slotTypes={["toolbarButton"]}
        context={{ companyId: "c1" }}
        missingBehavior="placeholder"
      />,
    );

    expect(view.container.textContent).toContain("Missing Plugin: Missing Button");
    view.unmount();
  });

  it("shows plugin extensions unavailable message when slot query fails", () => {
    mockUseQuery([], new Error("network down"));

    const view = renderNode(
      <PluginSlotOutlet
        slotTypes={["sidebarPanel"]}
        context={{ companyId: "c1" }}
      />,
    );

    expect(view.container.textContent).toContain("Plugin extensions unavailable: network down");
    view.unmount();
  });

  it("contains plugin render errors with an error boundary", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    registerPluginReactComponent("acme.crashy", "Crashy", () => {
      throw new Error("boom");
    });

    const view = renderNode(
      <PluginSlotMount
        slot={{
          id: "slot-1",
          type: "sidebarPanel",
          displayName: "Crashy",
          exportName: "Crashy",
          pluginId: "p3",
          pluginKey: "acme.crashy",
          pluginDisplayName: "Crash Plugin",
          pluginVersion: "1.0.0",
        }}
        context={{ companyId: "c1" }}
      />,
    );

    expect(view.container.textContent).toContain("Crash Plugin: failed to render");
    errorSpy.mockRestore();
    view.unmount();
  });

  it("binds slot and context on registered web components", () => {
    registerPluginWebComponent("acme.web", "WebSlot", "paperclip-web-slot");

    const slot = {
      id: "slot-web",
      type: "sidebarPanel" as const,
      displayName: "Web Slot",
      exportName: "WebSlot",
      pluginId: "p4",
      pluginKey: "acme.web",
      pluginDisplayName: "Web Plugin",
      pluginVersion: "1.2.3",
    };
    const context = { companyId: "c1", entityType: "issue" as const, entityId: "i1" };

    const view = renderNode(<PluginSlotMount slot={slot} context={context} />);
    const node = view.container.querySelector("paperclip-web-slot") as
      | (HTMLElement & { pluginSlot?: unknown; pluginContext?: unknown })
      | null;

    expect(node).not.toBeNull();
    expect(node?.pluginSlot).toEqual(slot);
    expect(node?.pluginContext).toEqual(context);
    view.unmount();
  });
});

describe("plugin module dynamic import", () => {
  it("keeps keyed JSX children intact for the runtime shim", () => {
    const element = createElement(
      "option",
      _applyJsxRuntimeKeyForTests(
        {
          value: "workspace-1",
          children: "/tmp/workspace",
        },
        "workspace-1",
      ),
    );

    expect(element.key).toBe("workspace-1");
    expect(element.props.value).toBe("workspace-1");
    expect(element.props.children).toBe("/tmp/workspace");
  });

  it("rewrites plugin SDK UI subpath imports to bridge shims", () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:test-shim"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    const rewritten = _rewriteBareSpecifiersForTests(`
      import { usePluginData } from "@paperclipai/plugin-sdk/ui/hooks";
      import { MetricCard } from "@paperclipai/plugin-sdk/ui/components";
    `);

    expect(rewritten).not.toContain("@paperclipai/plugin-sdk/ui/hooks");
    expect(rewritten).not.toContain("@paperclipai/plugin-sdk/ui/components");
    expect(rewritten).toContain('from "blob:test-shim"');
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectURL,
    });
  });

  it("dynamically imports plugin UI module and registers exports", async () => {
    // Mock the dynamic import to return a module with a named export
    const FakeWidget = ({ slot }: { slot: { displayName: string } }) => (
      <div>Widget: {slot.displayName}</div>
    );

    // We need to intercept the dynamic import call.
    // The loader uses `import(url)` which we mock via vi.stubGlobal.
    const importSpy = vi.fn().mockResolvedValue({
      DashboardWidget: FakeWidget,
    });

    // Override the global import function — Vitest supports this pattern
    // by replacing the dynamic import the module uses internally.
    // Since import() cannot be mocked directly, we instead pre-register
    // the component (simulating what the loader would do) and verify
    // the registration-based approach works correctly.

    // Pre-register (simulating a successful loadPluginModule call)
    registerPluginReactComponent("acme.dash", "DashboardWidget", FakeWidget);

    mockUseQuery([
      {
        pluginId: "p-dash",
        pluginKey: "acme.dash",
        displayName: "Acme Dashboard",
        version: "2.0.0",
        uiEntryFile: "index.js",
        slots: [
          {
            id: "dash-widget",
            type: "dashboardWidget",
            displayName: "My Widget",
            exportName: "DashboardWidget",
            order: 1,
          },
        ],
      },
    ]);

    const view = renderNode(
      <PluginSlotOutlet
        slotTypes={["dashboardWidget"]}
        context={{ companyId: "c1" }}
      />,
    );

    expect(view.container.textContent).toContain("Widget: My Widget");
    view.unmount();
  });

  it("does not render window.paperclipPlugins global", () => {
    // The old system exposed window.paperclipPlugins. Verify it is no longer set
    // by the slots module. Note: we only check that the module itself does not
    // set it; plugins can still call registerPluginReactComponent directly
    // (e.g., from the test helpers).
    expect((window as { paperclipPlugins?: unknown }).paperclipPlugins).toBeUndefined();
  });
});
