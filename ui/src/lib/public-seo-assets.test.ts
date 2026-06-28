import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("public SEO assets", () => {
  it("publishes robots.txt with the production sitemap reference", () => {
    const robots = readFileSync(resolve(uiRoot, "public/robots.txt"), "utf8");

    expect(robots).toContain("User-Agent: *");
    expect(robots).toContain("Allow: /");
    expect(robots).toContain("Sitemap: https://paperclip.ing/sitemap.xml");
    expect(robots).not.toContain("<html");
  });

  it("publishes a sitemap for public indexable routes", () => {
    const sitemap = readFileSync(resolve(uiRoot, "public/sitemap.xml"), "utf8");

    expect(sitemap).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(sitemap).toContain("<loc>https://paperclip.ing/</loc>");
    expect(sitemap).toContain("<loc>https://paperclip.ing/design-guide</loc>");
    expect((sitemap.match(/<loc>/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(sitemap).not.toContain("<!DOCTYPE html>");
  });
});
