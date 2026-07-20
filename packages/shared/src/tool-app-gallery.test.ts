import { describe, expect, it } from "vitest";
import {
  getToolAppGalleryEntryForUrl,
  TOOL_APP_GALLERY,
} from "./tool-app-gallery.js";

describe("tool app gallery URL matching", () => {
  it("matches pasted links against gallery URL patterns", () => {
    expect(getToolAppGalleryEntryForUrl("https://mcp.zapier.com/api/mcp")?.key).toBe("zapier");
    expect(getToolAppGalleryEntryForUrl("https://api.githubcopilot.com/mcp/")?.key).toBe("github");
    expect(getToolAppGalleryEntryForUrl("https://docs.google.com/spreadsheets/d/sheet_123/edit")?.key).toBe("google-sheets");
  });

  it("returns null for invalid or unknown links", () => {
    expect(getToolAppGalleryEntryForUrl("not a url")).toBeNull();
    expect(getToolAppGalleryEntryForUrl("https://example.com/mcp")).toBeNull();
    expect(getToolAppGalleryEntryForUrl("https://docs.googleapis.com/drive/v3/files")).toBeNull();
  });

  it("does not list Google Drive until its OAuth client flow is supported", () => {
    expect(TOOL_APP_GALLERY.map((entry) => entry.key)).not.toContain("google-drive");
    expect(getToolAppGalleryEntryForUrl("https://mcp.google.com/drive")).toBeNull();
  });

  it("keeps every gallery entry reachable through at least one pattern", () => {
    for (const entry of TOOL_APP_GALLERY) {
      const example = entry.urlPatterns[0]?.replace("*", "example");
      expect(example, `${entry.key} has a pattern`).toBeTruthy();
      expect(getToolAppGalleryEntryForUrl(example!)?.key).toBe(entry.key);
    }
  });
});
