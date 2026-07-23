// @vitest-environment jsdom

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import {
  PluginSlotMount,
  _collectRegisterableExportNamesForTests,
  _resetPluginModuleLoader,
  registerPluginReactComponent,
  registerPluginWebComponent,
  type ResolvedPluginSlot,
} from "./slots";

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) {
    flushSync(() => {
      root.unmount();
    });
  }
  roots = [];
  _resetPluginModuleLoader();
});

describe("plugin slot export registration", () => {
  it("keeps declared missing exports visible for diagnostics", () => {
    const exports = _collectRegisterableExportNamesForTests(
      { Page: () => null },
      new Set(["Page", "MissingRouteSidebar"]),
    );

    expect([...exports]).toEqual(["Page", "MissingRouteSidebar"]);
  });

  it("registers component-like module exports even when the current contribution did not declare them", () => {
    const exports = _collectRegisterableExportNamesForTests(
      {
        Page: () => null,
        RouteSidebar: () => null,
        webComponentTag: "paperclip-widget",
        metadata: { ignored: true },
        count: 1,
        default: () => null,
      },
      new Set(["Page"]),
    );

    expect(exports).toEqual(new Set(["Page", "RouteSidebar", "webComponentTag"]));
  });

  it("updates an already-mounted placeholder when the slot export registers later", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const slot: ResolvedPluginSlot = {
      type: "routeSidebar",
      id: "content-machine-sidebar",
      displayName: "Content",
      exportName: "ContentMachineRouteSidebar",
      routePath: "content-machine",
      pluginId: "content-machine-plugin",
      pluginKey: "content-machine",
      pluginDisplayName: "Content Machine",
      pluginVersion: "1.0.0",
    };

    flushSync(() => {
      root.render(createElement(PluginSlotMount, {
        slot,
        context: { companyId: "company-1", companyPrefix: "PAP" },
        missingBehavior: "placeholder",
      }));
    });

    expect(container.textContent).toContain("Content Machine: Content");

    flushSync(() => {
      registerPluginWebComponent("content-machine", "ContentMachineRouteSidebar", "paperclip-test-sidebar");
    });

    expect(container.textContent).not.toContain("Content Machine: Content");
    expect(container.querySelector("paperclip-test-sidebar")).not.toBeNull();
  });

  it("forwards host-provided component props to React slot components", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient();
    roots.push(root);
    const payload = { title: "Open deployment deck" };
    const slot: ResolvedPluginSlot = {
      type: "approvalCard",
      id: "approval-card",
      displayName: "Approval Card",
      exportName: "ApprovalCard",
      pluginId: "approval-plugin",
      pluginKey: "approval-plugin",
      pluginDisplayName: "Approval Plugin",
      pluginVersion: "1.0.0",
    };

    registerPluginReactComponent("approval-plugin", "ApprovalCard", ({ payload: receivedPayload }) => (
      createElement("div", null, (receivedPayload as typeof payload).title)
    ));

    flushSync(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(PluginSlotMount, {
            slot,
            context: { companyId: "company-1", companyPrefix: "PAP" },
            componentProps: { payload },
          }),
        ),
      );
    });

    expect(container.textContent).toContain("Open deployment deck");
  });
});
