import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarLink, WeKnoraPage } from "../src/ui/index.js";

afterEach(() => {
  delete (globalThis as typeof globalThis & { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__;
});

describe("WeKnora UI", () => {
  it("renders the navigation entry and configured overview without secret material", () => {
    const bridge = {
      sdkUi: {
        usePluginData: (key: string) => ({
          data: key === "overview" ? { configured: true, baseUrl: "https://weknora.example/api/v1", tenantConfigured: false, enableWriteActions: false } : key === "knowledge-bases" ? { knowledgeBases: [] } : key === "health" ? { status: "ok", checkedAt: "2026-01-01T00:00:00.000Z", warnings: [] } : null,
          loading: false, error: null, refresh: () => undefined,
        }),
        usePluginAction: () => async () => undefined,
        usePluginToast: () => () => null,
      },
    };
    (globalThis as typeof globalThis & { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__ = bridge;
    const page = renderToStaticMarkup(createElement(WeKnoraPage, { context: { companyId: "company-1", companyPrefix: "THI", projectId: null, entityId: null, entityType: null, userId: "board-1" } }));
    expect(renderToStaticMarkup(createElement(SidebarLink))).toContain("WeKnora");
    expect(page).toContain("https://weknora.example/api/v1");
    expect(page).toContain("disabled by default");
    expect(page).not.toContain("fixture-api-key");
  });
});
