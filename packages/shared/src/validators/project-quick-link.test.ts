import { describe, expect, it } from "vitest";
import {
  createProjectQuickLinkSchema,
  deriveProjectQuickLinkTitle,
  previewProjectQuickLinkSchema,
  updateProjectQuickLinkSchema,
} from "./project-quick-link.js";

describe("project quick link validators", () => {
  it("accepts http and https URLs", () => {
    expect(createProjectQuickLinkSchema.parse({ url: "https://example.com/docs" })).toMatchObject({
      url: "https://example.com/docs",
    });
    expect(createProjectQuickLinkSchema.parse({ title: "Docs", url: "http://example.com/docs" })).toMatchObject({
      title: "Docs",
      url: "http://example.com/docs",
    });
  });

  it("rejects non-web URL protocols", () => {
    expect(() => createProjectQuickLinkSchema.parse({ url: "ftp://example.com/file" })).toThrow(/http or https/);
    expect(() => updateProjectQuickLinkSchema.parse({ url: "file:///tmp/report.md" })).toThrow(/http or https/);
    expect(() => previewProjectQuickLinkSchema.parse({ url: "mailto:team@example.com" })).toThrow(/http or https/);
  });

  it("requires at least one update field", () => {
    expect(() => updateProjectQuickLinkSchema.parse({})).toThrow(/At least one/);
  });

  it("derives titles from explicit title or URL host", () => {
    expect(deriveProjectQuickLinkTitle({ title: "  Runbook  ", url: "https://example.com/runbook" })).toBe("Runbook");
    expect(deriveProjectQuickLinkTitle({ url: "https://www.example.com/runbook" })).toBe("example.com");
  });

  it("accepts sanitized rich metadata fields", () => {
    expect(createProjectQuickLinkSchema.parse({
      url: "https://example.com/docs",
      siteName: " Example Docs ",
      description: " Project documentation ",
      imageUrl: "https://example.com/og.png",
      faviconUrl: "https://example.com/favicon.ico",
    })).toMatchObject({
      siteName: "Example Docs",
      description: "Project documentation",
      imageUrl: "https://example.com/og.png",
      faviconUrl: "https://example.com/favicon.ico",
    });
  });

  it("rejects malformed rich metadata fields", () => {
    expect(() => createProjectQuickLinkSchema.parse({
      url: "https://example.com/docs",
      imageUrl: "notaurl",
    })).toThrow(/Invalid url/);
    expect(() => updateProjectQuickLinkSchema.parse({
      faviconUrl: "ftp://example.com/favicon.ico",
    })).toThrow(/http or https/);
    expect(() => createProjectQuickLinkSchema.parse({
      url: "https://example.com/docs",
      description: "x".repeat(501),
    })).toThrow();
  });
});
