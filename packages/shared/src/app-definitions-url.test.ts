import { describe, expect, it } from "vitest";
import {
  getAppDefinitionForUrl,
  CONNECTABLE_APP_DEFINITIONS,
} from "./app-definitions.js";

describe("tool app gallery URL matching", () => {
  it("matches pasted links against gallery URL patterns", () => {
    expect(getAppDefinitionForUrl("https://mcp.zapier.com/api/mcp")?.slug).toBe("zapier");
    expect(getAppDefinitionForUrl("https://api.githubcopilot.com/mcp/")?.slug).toBe("github");
    expect(getAppDefinitionForUrl("https://docs.google.com/spreadsheets/d/sheet_123/edit")?.slug).toBe("google-sheets");
    expect(getAppDefinitionForUrl("https://gmailmcp.googleapis.com/mcp/v1")?.slug).toBe("gmail");
  });

  it("returns null for invalid or unknown links", () => {
    expect(getAppDefinitionForUrl("not a url")).toBeNull();
    expect(getAppDefinitionForUrl("https://example.com/mcp")).toBeNull();
    expect(getAppDefinitionForUrl("https://docs.googleapis.com/drive/v3/files")).toBeNull();
  });

  it("lists each reviewed Google Workspace MCP endpoint independently", () => {
    expect(CONNECTABLE_APP_DEFINITIONS.map((app) => app.slug)).toEqual(expect.arrayContaining([
      "gmail",
      "google-drive",
      "google-docs",
      "google-sheets",
      "google-slides",
      "google-calendar",
      "google-chat",
      "google-people",
      "google-workspace-search",
    ]));
    expect(getAppDefinitionForUrl("https://drivemcp.googleapis.com/mcp/v1")?.slug).toBe("google-drive");
  });

  it("lists Composio as a connectable API-key app", () => {
    const composio = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "composio");
    expect(composio?.methods).toEqual([
      expect.objectContaining({ key: "api-key", transport: "rest_api", auth: "api_key" }),
    ]);
  });

  it("keeps every gallery entry reachable through at least one pattern", () => {
    for (const app of CONNECTABLE_APP_DEFINITIONS) {
      const example = app.urlPatterns[0]?.replace("*", "example");
      expect(example, `${app.slug} has a pattern`).toBeTruthy();
      expect(getAppDefinitionForUrl(example!)?.slug).toBe(app.slug);
    }
  });
});
