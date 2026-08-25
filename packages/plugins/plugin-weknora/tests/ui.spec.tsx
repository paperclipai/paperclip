import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarLink, WeKnoraPage } from "../src/ui/index.js";

afterEach(() => {
  delete (globalThis as typeof globalThis & { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__;
});

describe("WeKnora UI", () => {
  function renderPage(overrides: Record<string, unknown> = {}) {
    const bridge = {
      sdkUi: {
        usePluginData: (key: string) => ({
          data: overrides[key] ?? (key === "overview" ? { configured: true, baseUrl: "https://weknora.example/api/v1", tenantConfigured: false, enableWriteActions: false } : key === "knowledge-bases" ? { knowledgeBases: [] } : key === "health" ? { status: "ok", checkedAt: "2026-01-01T00:00:00.000Z", warnings: [] } : null),
          loading: false, error: null, refresh: () => undefined,
        }),
        usePluginAction: () => async () => undefined,
        usePluginToast: () => () => null,
      },
    };
    (globalThis as typeof globalThis & { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__ = bridge;
    return renderToStaticMarkup(createElement(WeKnoraPage, { context: { companyId: "company-1", companyPrefix: "THI", projectId: null, entityId: null, entityType: null, userId: "board-1" } }));
  }

  it("renders the navigation entry and configured overview without secret material", () => {
    const page = renderPage({
      "knowledge-bases": { knowledgeBases: [{ id: "kb-1", name: "Engineering", knowledgeCount: 2, chunkCount: 4, processingCount: 0 }] },
      health: { status: "degraded", checkedAt: "2026-01-01T00:00:00.000Z", warnings: ["Wiki lint unavailable"] },
    });
    expect(renderToStaticMarkup(createElement(SidebarLink))).toContain("WeKnora");
    expect(page).toContain("https://weknora.example/api/v1");
    expect(page).toContain("Engineering");
    expect(page).toContain("degraded");
    expect(page).toContain("disabled by default");
    expect(page).not.toContain("fixture-api-key");
  });

  it("shows empty and missing-secret states without exposing credentials", () => {
    const page = renderPage({
      overview: { configured: false, error: { kind: "auth", message: "WeKnora API key secret could not be resolved" } },
      health: { status: "unavailable", checkedAt: "2026-01-01T00:00:00.000Z", warnings: ["WeKnora API key secret could not be resolved"], error: { kind: "auth", message: "WeKnora API key secret could not be resolved" } },
    });
    expect(page).toContain("Configuration required");
    expect(page).toContain("WeKnora API key secret could not be resolved");
    expect(page).toContain("unavailable");
    expect(page).toContain("No knowledge bases are visible.");
    expect(page).not.toContain("fixture-api-key");
  });
});
