// @vitest-environment jsdom
import * as React from "react";
import * as ReactDOM from "react-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { MouseEvent as ReactMouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileTree as SdkFileTree,
  ManagedRoutinesList as SdkManagedRoutinesList,
  MarkdownBlock as SdkMarkdownBlock,
  MarkdownEditor as SdkMarkdownEditor,
  type FileTreeNode as SdkFileTreeNode,
} from "../../../packages/plugins/sdk/src/ui/components";
import { SidebarProvider, useSidebar } from "@/context/SidebarContext";
import {
  PluginBridgeContext,
  resolveHostNavigationHref,
  shouldHandleHostNavigationClick,
  useHostNavigation,
  type PluginBridgeContextValue,
} from "./bridge";
import { initPluginBridge } from "./bridge-init";

function clickEvent(
  overrides: Partial<ReactMouseEvent<HTMLAnchorElement>> = {},
): ReactMouseEvent<HTMLAnchorElement> {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    currentTarget: {
      hasAttribute: () => false,
    },
    ...overrides,
  } as ReactMouseEvent<HTMLAnchorElement>;
}

afterEach(() => {
  delete globalThis.__paperclipPluginBridge__;
});

describe("plugin host navigation", () => {
  it("resolves plugin page routes into the active company prefix", () => {
    expect(resolveHostNavigationHref("/wiki", "PAP")).toBe("/PAP/wiki");
    expect(resolveHostNavigationHref("/wiki?tab=browse#page", "pap")).toBe(
      "/PAP/wiki?tab=browse#page",
    );
  });

  it("does not double-prefix active company paths or global host paths", () => {
    expect(resolveHostNavigationHref("/PAP/wiki", "PAP")).toBe("/PAP/wiki");
    expect(resolveHostNavigationHref("/pap/wiki", "PAP")).toBe("/pap/wiki");
    expect(resolveHostNavigationHref("/instance/settings/plugins", "PAP")).toBe(
      "/instance/settings/plugins",
    );
  });

  it("intercepts only same-origin plain left-click navigation", () => {
    expect(shouldHandleHostNavigationClick(clickEvent(), "/PAP/wiki")).toBe(true);
    expect(
      shouldHandleHostNavigationClick(clickEvent({ ctrlKey: true }), "/PAP/wiki"),
    ).toBe(false);
    expect(
      shouldHandleHostNavigationClick(clickEvent(), "/PAP/wiki", "_blank"),
    ).toBe(false);
    expect(
      shouldHandleHostNavigationClick(clickEvent(), "https://example.com/wiki"),
    ).toBe(false);
  });
});

describe("useHostNavigation mobile drawer behavior", () => {
  // React 19's `act` requires the env flag and React DOM client.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  function makeBridgeValue(): PluginBridgeContextValue {
    return {
      pluginId: "test-plugin",
      hostContext: {
        companyId: "co",
        companyPrefix: "PAP",
        projectId: null,
        entityId: null,
        entityType: null,
        userId: null,
      },
    };
  }

  function setViewport(width: number) {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: width,
    });
    if (typeof window.matchMedia !== "function") {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: (query: string) => ({
          matches: /max-width:\s*767px/.test(query) ? width < 768 : false,
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }),
      });
    }
  }

  it("closes the sidebar drawer on mobile after a same-origin navigate()", () => {
    setViewport(390);

    let nav: ReturnType<typeof useHostNavigation> | null = null;
    let sidebar: ReturnType<typeof useSidebar> | null = null;
    function Probe() {
      nav = useHostNavigation();
      sidebar = useSidebar();
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/PAP/wiki"] },
          React.createElement(
            SidebarProvider,
            null,
            React.createElement(
              PluginBridgeContext.Provider,
              { value: makeBridgeValue() },
              React.createElement(Probe),
            ),
          ),
        ),
      );
    });

    expect(sidebar!.isMobile).toBe(true);
    act(() => sidebar!.setSidebarOpen(true));
    expect(sidebar!.sidebarOpen).toBe(true);

    act(() => nav!.navigate("/wiki?section=ingest"));
    expect(sidebar!.sidebarOpen).toBe(false);

    act(() => root.unmount());
    container.remove();
  });

  it("leaves the sidebar open on desktop after navigate()", () => {
    setViewport(1280);

    let nav: ReturnType<typeof useHostNavigation> | null = null;
    let sidebar: ReturnType<typeof useSidebar> | null = null;
    function Probe() {
      nav = useHostNavigation();
      sidebar = useSidebar();
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/PAP/wiki"] },
          React.createElement(
            SidebarProvider,
            null,
            React.createElement(
              PluginBridgeContext.Provider,
              { value: makeBridgeValue() },
              React.createElement(Probe),
            ),
          ),
        ),
      );
    });

    expect(sidebar!.isMobile).toBe(false);
    expect(sidebar!.sidebarOpen).toBe(true);

    act(() => nav!.navigate("/wiki?section=ingest"));
    expect(sidebar!.sidebarOpen).toBe(true);

    act(() => root.unmount());
    container.remove();
  });
});

describe("plugin SDK FileTree bridge", () => {
  const nodes: SdkFileTreeNode[] = [
    {
      name: "wiki",
      path: "wiki",
      kind: "dir",
      children: [
        {
          name: "index.md",
          path: "wiki/index.md",
          kind: "file",
          children: [],
        },
      ],
    },
  ];

  it("injects the host FileTree implementation through the bridge runtime", () => {
    initPluginBridge(React, ReactDOM);

    const html = renderToStaticMarkup(
      React.createElement(SdkFileTree, {
        nodes,
        expandedPaths: ["wiki"],
        selectedFile: "wiki/index.md",
        onToggleDir: () => undefined,
        onSelectFile: () => undefined,
      }),
    );

    expect(html).toContain('role="tree"');
    expect(html).toContain("wiki");
    expect(html).toContain("index.md");
  });

  it("throws a clear error when the host FileTree implementation is missing", () => {
    globalThis.__paperclipPluginBridge__ = {
      react: React,
      reactDom: ReactDOM,
      sdkUi: {},
    };

    expect(() =>
      renderToStaticMarkup(
        React.createElement(SdkFileTree, {
          nodes,
          expandedPaths: ["wiki"],
          onToggleDir: () => undefined,
          onSelectFile: () => undefined,
        }),
      ),
    ).toThrow('Paperclip plugin UI runtime is not initialized for "FileTree"');
  });
});

describe("plugin SDK markdown component bridge", () => {
  it("injects markdown display and editor components through the bridge runtime", () => {
    initPluginBridge(React, ReactDOM);

    const registry = globalThis.__paperclipPluginBridge__?.sdkUi ?? {};
    expect(registry.MarkdownBlock).toBeTypeOf("function");
    expect(registry.MarkdownEditor).toBeTypeOf("function");
    expect(registry.IssuesList).toBeTypeOf("function");
    expect(registry.AssigneePicker).toBeTypeOf("function");
    expect(registry.ProjectPicker).toBeTypeOf("function");
    expect(registry.ManagedRoutinesList).toBeTypeOf("function");
  });

  it("renders plugin-provided markdown components when registered by the host", () => {
    globalThis.__paperclipPluginBridge__ = {
      react: React,
      reactDom: ReactDOM,
      sdkUi: {
        MarkdownBlock: ({ content, enableWikiLinks, wikiLinkRoot }: { content: string; enableWikiLinks?: boolean; wikiLinkRoot?: string }) =>
          React.createElement("article", {
            "data-wiki-links": enableWikiLinks ? "true" : "false",
            "data-wiki-root": wikiLinkRoot,
          }, content),
        MarkdownEditor: ({ value }: { value: string }) =>
          React.createElement("textarea", { value, readOnly: true }),
        ManagedRoutinesList: ({ routines }: { routines: Array<{ title: string }> }) =>
          React.createElement("section", null, routines.map((routine) => routine.title).join(", ")),
      },
    };

    const markdownHtml = renderToStaticMarkup(React.createElement(SdkMarkdownBlock, {
      content: "# Wiki",
      enableWikiLinks: true,
      wikiLinkRoot: "/wiki/page",
    }));
    expect(markdownHtml).toContain("# Wiki");
    expect(markdownHtml).toContain('data-wiki-links="true"');
    expect(markdownHtml).toContain('data-wiki-root="/wiki/page"');
    expect(renderToStaticMarkup(React.createElement(SdkMarkdownEditor, { value: "# Wiki", onChange: () => undefined }))).toContain("# Wiki");
    expect(renderToStaticMarkup(React.createElement(SdkManagedRoutinesList, {
      routines: [{ key: "lint", title: "Run lint", status: "active" }],
    }))).toContain("Run lint");
  });
});
