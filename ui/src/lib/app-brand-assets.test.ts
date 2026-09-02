import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type BrandProvider = {
  slug: string;
  localAsset: string;
  darkAsset?: string;
  assetType: "svg" | "png";
  darkVariantRequired: boolean;
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
  it("maps every provider to a unique local asset that exists", () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.providers.length).toBeGreaterThan(50);
    expect(new Set(manifest.providers.map((provider) => provider.slug)).size).toBe(
      manifest.providers.length,
    );

    for (const provider of manifest.providers) {
      const assetPath = publicAssetPath(provider.localAsset);
      expect(existsSync(assetPath), `${provider.slug} local asset should exist`).toBe(true);
      expect(statSync(assetPath).isFile(), `${provider.slug} local asset should be a file`).toBe(true);
      expect(path.extname(assetPath)).toBe(`.${provider.assetType}`);
    }
  });

  it("ships each required dark-theme variant", () => {
    for (const provider of manifest.providers.filter((entry) => entry.darkVariantRequired)) {
      expect(provider.darkAsset, `${provider.slug} should declare a dark asset`).toBeTruthy();
      const assetPath = publicAssetPath(provider.darkAsset!);
      expect(existsSync(assetPath), `${provider.slug} dark asset should exist`).toBe(true);
      expect(statSync(assetPath).isFile(), `${provider.slug} dark asset should be a file`).toBe(true);
    }
  });
});
