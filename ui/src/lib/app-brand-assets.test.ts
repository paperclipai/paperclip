import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type BrandProvider = {
  slug: string;
  localAsset: string;
  darkAsset?: string;
};

type BrandManifest = {
  schemaVersion: number;
  providers: BrandProvider[];
};

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(uiRoot, "public", "brands", "apps", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BrandManifest;

function publicAssetPath(asset: string): string {
  expect(asset).toMatch(/^\/brands\/apps\/[a-z0-9-]+\.(svg|png)$/);
  return path.join(uiRoot, "public", asset.slice(1));
}

describe("local app brand assets", () => {
  it("maps each unique provider identity to an existing local asset", () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.providers.length).toBeGreaterThan(50);
    expect(new Set(manifest.providers.map((provider) => provider.slug)).size).toBe(
      manifest.providers.length,
    );

    for (const provider of manifest.providers) {
      const assetPath = publicAssetPath(provider.localAsset);
      expect(existsSync(assetPath), `${provider.slug} local asset should exist`).toBe(true);
      expect(statSync(assetPath).isFile(), `${provider.slug} local asset should be a file`).toBe(true);
      expect([".svg", ".png"]).toContain(path.extname(assetPath));
    }
  });

  it("ships each required dark-theme variant", () => {
    for (const provider of manifest.providers.filter((entry) => entry.darkAsset)) {
      expect(provider.darkAsset, `${provider.slug} should declare a dark asset`).toBeTruthy();
      const assetPath = publicAssetPath(provider.darkAsset!);
      expect(existsSync(assetPath), `${provider.slug} dark asset should exist`).toBe(true);
      expect(statSync(assetPath).isFile(), `${provider.slug} dark asset should be a file`).toBe(true);
    }
  });
});

import { resolveLocalAppBrandAssets } from "./app-brand-assets";

describe("brand lookup", () => {
  const registry = { schemaVersion: 1, providers: [{
    slug: "google-people", provider: "Google People", aliases: ["Google Contacts"],
    localAsset: "/brands/apps/google-people.svg",
  }, {
    slug: "google-workspace-search", provider: "Google Workspace Search",
    localAsset: "/brands/apps/google-people.svg",
  }] };
  it.each(["google-people", "Google People", "  GOOGLE CONTACTS "])("resolves stable keys, names and explicit aliases: %s", (key) => {
    expect(resolveLocalAppBrandAssets(registry, key)).toEqual({ light: "/brands/apps/google-people.svg", dark: "/brands/apps/google-people.svg" });
  });
  it("permits intentional shared art without merging provider identities", () => {
    expect(resolveLocalAppBrandAssets(registry, "google-workspace-search")).toEqual(resolveLocalAppBrandAssets(registry, "google-people"));
    expect(registry.providers.map((row) => row.slug)).toEqual(["google-people", "google-workspace-search"]);
  });
  it("rejects a nonlocal manifest path and does not guess owner-qualified names", () => {
    expect(resolveLocalAppBrandAssets({ schemaVersion: 1, providers: [{ slug: "custom", provider: "Custom", localAsset: "https://remote.example/logo.svg" }] }, "custom")).toBeNull();
    expect(resolveLocalAppBrandAssets(registry, "Alice's Google People")).toBeNull();
  });
});
