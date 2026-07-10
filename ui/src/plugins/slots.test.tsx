// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  _getReactShimSourceForTests,
  _shouldSubscribeToPluginModuleLoadForTests,
  PluginSlotMount,
  type ResolvedPluginSlot,
} from "./slots";

describe("plugin UI compatibility shims", () => {
  it("exports useDeferredValue for the LLM Wiki UI bundle", () => {
    const source = _getReactShimSourceForTests();

    expect(source).toMatch(/const \{[^}]*useDeferredValue[^}]*\} = R;/s);
    expect(source).toMatch(/export \{[^}]*useDeferredValue[^}]*\};/s);
  });
});

describe("plugin module load subscriptions", () => {
  it("keeps a second slot host subscribed while the shared module is loading", () => {
    expect(_shouldSubscribeToPluginModuleLoadForTests(undefined)).toBe(true);
    expect(_shouldSubscribeToPluginModuleLoadForTests("idle")).toBe(true);
    expect(_shouldSubscribeToPluginModuleLoadForTests("loading")).toBe(true);
    expect(_shouldSubscribeToPluginModuleLoadForTests("error")).toBe(true);
    expect(_shouldSubscribeToPluginModuleLoadForTests("loaded")).toBe(false);
  });
});

describe("plugin sidebar fallback", () => {
  it("renders a clickable company-scoped page link while the plugin module is unavailable", () => {
    const slot: ResolvedPluginSlot = {
      type: "sidebar",
      id: "wiki-sidebar",
      displayName: "Wiki",
      exportName: "SidebarLink",
      order: 35,
      pluginId: "wiki-plugin-id",
      pluginKey: "paperclipai.plugin-llm-wiki",
      pluginDisplayName: "LLM Wiki",
      pluginVersion: "0.1.0",
      pluginPageRoutePath: "wiki",
    };

    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(PluginSlotMount, {
          slot,
          context: { companyId: "company-id", companyPrefix: "PAP" },
          missingBehavior: "placeholder",
        }),
      ),
    );

    expect(markup).toContain('href="/PAP/wiki"');
    expect(markup).toContain('aria-label="Open Wiki"');
    expect(markup).toContain(">Wiki</a>");
    expect(markup).not.toContain("LLM Wiki: Wiki");
  });
});
