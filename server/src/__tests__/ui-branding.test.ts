import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyUiBranding,
  getBrandDir,
  getWorktreeUiBranding,
  isWorktreeUiBrandingEnabled,
  renderBrandStylesheetLink,
  renderFaviconLinks,
  renderRuntimeBrandingMeta,
  resolveDefaultTheme,
} from "../ui-branding.js";

const TEMPLATE = `<!doctype html>
<head>
    <!-- PAPERCLIP_RUNTIME_BRANDING_START -->
    <!-- PAPERCLIP_RUNTIME_BRANDING_END -->
    <!-- PAPERCLIP_FAVICON_START -->
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
    <!-- PAPERCLIP_FAVICON_END -->
</head>`;

describe("ui branding", () => {
  it("detects worktree mode from PAPERCLIP_IN_WORKTREE", () => {
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "true" })).toBe(true);
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "1" })).toBe(true);
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "false" })).toBe(false);
  });

  it("resolves name, color, and text color for worktree branding", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
      PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
    });

    expect(branding.enabled).toBe(true);
    expect(branding.name).toBe("paperclip-pr-432");
    expect(branding.color).toBe("#4f86f7");
    expect(branding.textColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(branding.faviconHref).toContain("data:image/svg+xml,");
  });

  it("renders a dynamic worktree favicon when enabled", () => {
    const links = renderFaviconLinks(
      getWorktreeUiBranding({
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
        PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
      }),
    );
    expect(links).toContain("data:image/svg+xml,");
    expect(links).toContain('rel="shortcut icon"');
  });

  it("renders runtime branding metadata for the ui", () => {
    const meta = renderRuntimeBrandingMeta(
      getWorktreeUiBranding({
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
        PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
      }),
    );
    expect(meta).toContain('name="paperclip-worktree-name"');
    expect(meta).toContain('content="paperclip-pr-432"');
    expect(meta).toContain('name="paperclip-worktree-color"');
  });

  it("surfaces the runtime instance id so the UI can fail closed on copied rows", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
      PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
      PAPERCLIP_INSTANCE_ID: "inst-abc123",
    });
    expect(branding.instanceId).toBe("inst-abc123");

    const meta = renderRuntimeBrandingMeta(branding);
    expect(meta).toContain('name="paperclip-instance-id"');
    expect(meta).toContain('content="inst-abc123"');
  });

  it("omits the instance-id meta when the runtime id is unset", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
      PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
    });
    expect(branding.instanceId).toBeNull();
    expect(renderRuntimeBrandingMeta(branding)).not.toContain('name="paperclip-instance-id"');
  });

  it("rewrites the favicon and runtime branding blocks for worktree instances only", () => {
    const branded = applyUiBranding(TEMPLATE, {
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
      PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
    });
    expect(branded).toContain("data:image/svg+xml,");
    expect(branded).toContain('name="paperclip-worktree-name"');
    expect(branded).not.toContain('href="/favicon.svg"');

    const defaultHtml = applyUiBranding(TEMPLATE, {});
    expect(defaultHtml).toContain('href="/favicon.svg"');
    expect(defaultHtml).not.toContain('name="paperclip-worktree-name"');
  });

  it("resolves the brand directory only when PAPERCLIP_BRAND_DIR is set", () => {
    expect(getBrandDir({})).toBeNull();
    expect(getBrandDir({ PAPERCLIP_BRAND_DIR: "  " })).toBeNull();
    expect(getBrandDir({ PAPERCLIP_BRAND_DIR: "/etc/paperclip/branding" })).toBe(
      "/etc/paperclip/branding",
    );
  });

  it("emits the brand stylesheet link only when a brand dir is configured", () => {
    expect(renderBrandStylesheetLink({})).toBe("");
    const link = renderBrandStylesheetLink({ PAPERCLIP_BRAND_DIR: "/etc/paperclip/branding" });
    expect(link).toBe('<link rel="stylesheet" href="/branding/brand.css" />');
  });

  it("injects the brand stylesheet just before </head> so it wins the cascade", () => {
    const template = `<!doctype html>
<head>
    <!-- PAPERCLIP_RUNTIME_BRANDING_START -->
    <!-- PAPERCLIP_RUNTIME_BRANDING_END -->
    <!-- PAPERCLIP_FAVICON_START -->
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <!-- PAPERCLIP_FAVICON_END -->
    <link rel="stylesheet" crossorigin href="/assets/index-abc.css">
  </head>`;
    const branded = applyUiBranding(template, { PAPERCLIP_BRAND_DIR: "/etc/paperclip/branding" });
    expect(branded).toContain('<link rel="stylesheet" href="/branding/brand.css" />');
    // Brand link must come AFTER the bundled stylesheet so its var overrides win.
    expect(branded.indexOf("/branding/brand.css")).toBeGreaterThan(
      branded.indexOf("/assets/index-abc.css"),
    );
    // And it must sit inside <head>.
    expect(branded.indexOf("/branding/brand.css")).toBeLessThan(branded.indexOf("</head>"));
  });

  it("does not inject a brand stylesheet when the brand dir is unset", () => {
    const branded = applyUiBranding(TEMPLATE, {});
    expect(branded).not.toContain("/branding/brand.css");
  });

  it("resolveDefaultTheme reads PAPERCLIP_DEFAULT_THEME, null (OS preference) when unset", () => {
    expect(resolveDefaultTheme({})).toBeNull();
    expect(resolveDefaultTheme({ PAPERCLIP_DEFAULT_THEME: "light" })).toBe("light");
    expect(resolveDefaultTheme({ PAPERCLIP_DEFAULT_THEME: "LIGHT" })).toBe("light");
    expect(resolveDefaultTheme({ PAPERCLIP_DEFAULT_THEME: "dark" })).toBe("dark");
    expect(resolveDefaultTheme({ PAPERCLIP_DEFAULT_THEME: "  " })).toBeNull();
    expect(resolveDefaultTheme({ PAPERCLIP_DEFAULT_THEME: "solarized" })).toBeNull();
  });

  it("injects a paperclip-default-theme meta only when configured, before the inline theme script", () => {
    // The meta lives in the runtime-branding block, which precedes the inline
    // theme script, so the pre-React script reads it without a flash.
    const tpl = `<!doctype html><head>
    <!-- PAPERCLIP_RUNTIME_BRANDING_START -->
    <!-- PAPERCLIP_RUNTIME_BRANDING_END -->
    <!-- PAPERCLIP_FAVICON_START -->
    <!-- PAPERCLIP_FAVICON_END -->
    <script>var k="paperclip.theme";</script>
  </head>`;
    const light = applyUiBranding(tpl, { PAPERCLIP_DEFAULT_THEME: "light" });
    expect(light).toContain('<meta name="paperclip-default-theme" content="light" />');
    expect(light.indexOf("paperclip-default-theme")).toBeLessThan(light.indexOf("paperclip.theme"));
    const dark = applyUiBranding(tpl, { PAPERCLIP_DEFAULT_THEME: "dark" });
    expect(dark).toContain('<meta name="paperclip-default-theme" content="dark" />');
    // Unconfigured build stays free of the meta (OS preference remains the default).
    expect(applyUiBranding(tpl, {})).not.toContain("paperclip-default-theme");
  });

  // Regression guard for the brand-hook outage: a head comment in ui/index.html
  // that contained a LITERAL "</head>" made Vite inject the bundled entry script
  // before that (commented) close-head, burying <script src=index.js> inside the
  // comment so the SPA never booted (blank page). Keep head comments free of
  // literal close-head / asset tags.
  it("ui/index.html has a single </head> and no asset/close-head tags inside comments", () => {
    const candidates = [
      path.resolve(fileURLToPath(import.meta.url), "../../../../ui/index.html"),
      path.resolve(process.cwd(), "../ui/index.html"),
      path.resolve(process.cwd(), "ui/index.html"),
    ];
    const file = candidates.find((p) => fs.existsSync(p));
    expect(file, `ui/index.html not found in: ${candidates.join(", ")}`).toBeTruthy();
    const html = fs.readFileSync(file as string, "utf-8");
    expect(html.match(/<\/head>/gi)?.length ?? 0).toBe(1);
    const comments = html.match(/<!--[\s\S]*?-->/g) ?? [];
    for (const c of comments) {
      expect(/<\/head>/i.test(c)).toBe(false);
      expect(/<script[^>]*\bsrc=/i.test(c)).toBe(false);
      expect(/<link[^>]*\bhref=/i.test(c)).toBe(false);
    }
  });
});
