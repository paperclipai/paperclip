import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("PWA install mode", () => {
  it("installs to the home screen as a chromeless standalone app (TON-2311)", () => {
    const manifest = JSON.parse(readFileSync(resolve(uiRoot, "public/site.webmanifest"), "utf8")) as {
      display?: string;
    };
    const html = readFileSync(resolve(uiRoot, "index.html"), "utf8");

    // Standalone display drops the browser URL bar on Android/Chrome installs.
    expect(manifest.display).toBe("standalone");
    // iOS only honors add-to-home-screen standalone mode via these legacy metas.
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style"');
  });

  it("meets Android/Chrome installability criteria (TON-2311)", () => {
    const manifest = JSON.parse(readFileSync(resolve(uiRoot, "public/site.webmanifest"), "utf8")) as {
      name?: string;
      start_url?: string;
      icons?: Array<{ sizes?: string; purpose?: string }>;
    };

    // Chrome's add-to-home-screen / install prompt requires name + start_url,
    // 192px and 512px icons, and a maskable icon for adaptive launcher icons.
    expect(manifest.name).toBeTruthy();
    expect(manifest.start_url).toBeTruthy();
    const sizes = new Set((manifest.icons ?? []).map((i) => i.sizes));
    expect(sizes.has("192x192")).toBe(true);
    expect(sizes.has("512x512")).toBe(true);
    expect((manifest.icons ?? []).some((i) => (i.purpose ?? "").includes("maskable"))).toBe(true);
  });
});
