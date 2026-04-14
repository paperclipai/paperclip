import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("public branding config", () => {
  it("brands the docs site as Orchestrero without GitHub chrome", async () => {
    const docsConfigPath = path.join(repoRoot, "docs", "docs.json");
    const raw = await fs.readFile(docsConfigPath, "utf8");
    const docsConfig = JSON.parse(raw) as {
      name?: unknown;
      topbarLinks?: Array<{ name?: unknown; url?: unknown }>;
      footerSocials?: Record<string, unknown>;
      navigation?: {
        tabs?: Array<{
          groups?: Array<{
            pages?: unknown[];
          }>;
        }>;
      };
    };

    expect(docsConfig.name).toBe("Orchestrero");
    expect(docsConfig.topbarLinks ?? []).toEqual([]);
    expect(docsConfig.footerSocials ?? {}).not.toHaveProperty("github");

    const pages = (docsConfig.navigation?.tabs ?? [])
      .flatMap((tab) => tab.groups ?? [])
      .flatMap((group) => group.pages ?? []);

    expect(pages).toContain("start/what-is-orchestrero");
    expect(pages).not.toContain("start/what-is-paperclip");
  });

  it("ships an Orchestrero web manifest", async () => {
    const manifestPath = path.join(repoRoot, "ui", "public", "site.webmanifest");
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as {
      name?: unknown;
      short_name?: unknown;
    };

    expect(manifest.name).toBe("Orchestrero");
    expect(manifest.short_name).toBe("Orchestrero");
  });

  it("exposes the public website intro page under the Orchestrero slug", async () => {
    const pagePath = path.join(repoRoot, "docs", "start", "what-is-orchestrero.md");
    const page = await fs.readFile(pagePath, "utf8");

    expect(page).toContain("title: What is Orchestrero?");
    expect(page).toContain("Orchestrero is the control plane for autonomous AI companies.");
  });
});
