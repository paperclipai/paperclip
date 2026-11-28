import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";

describe("manifest", () => {
  it("sol menü sayfası için gerekli yetenekleri beyan eder", () => {
    expect(manifest.capabilities).toContain("ui.sidebar.register");
    expect(manifest.capabilities).toContain("ui.page.register");
    expect(manifest.capabilities).toContain("issue.documents.read");
    expect(manifest.capabilities).toContain("issues.read");
    expect(manifest.capabilities).toContain("companies.read");
  });

  it("gizli anahtar veya dış istek yeteneği beyan etmez", () => {
    expect(manifest.capabilities).not.toContain("http.outbound");
    expect(manifest.capabilities).not.toContain("secrets.read-ref");
    expect(manifest.capabilities).not.toContain("env.write");
  });

  it("sayfa ve sidebar slot'larını tanımlar", () => {
    const tipler = manifest.ui?.slots?.map((slot) => slot.type) ?? [];
    expect(tipler).toContain("page");
    expect(tipler).toContain("sidebar");
    const page = manifest.ui?.slots?.find((slot) => slot.type === "page");
    expect(page?.routePath).toBe("sosyal-medya");
  });

  it("ayar şeması ve güvenli varsayılanlar beyan eder", () => {
    const ozellikler = (manifest.instanceConfigSchema?.properties ?? {}) as Record<
      string,
      { default?: unknown; maximum?: unknown }
    >;
    expect(ozellikler.documentKey?.default).toBe("sosyal-medya-durum");
    expect(ozellikler.scanLimit?.default).toBe(30);
    expect(ozellikler.scanLimit?.maximum).toBe(100);
  });
});
