import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyUiBranding,
  getWorktreeUiBranding,
  isWorktreeUiBrandingEnabled,
  renderFaviconLinks,
  renderRuntimeBrandingMeta,
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

  it("gives each default favicon a fixed-colour URL per colour scheme", () => {
    const links = renderFaviconLinks(getWorktreeUiBranding({})).split("\n");
    expect(links).toHaveLength(4);
    for (const link of links) {
      expect(link).toMatch(/data-favicon-light="\/[^"]+"/);
      expect(link).toMatch(/data-favicon-dark="\/[^"]+"/);
    }
    const joined = links.join("\n");
    expect(joined).toContain('data-favicon-light="/favicon-light.svg" data-favicon-dark="/favicon-dark.svg"');
    expect(joined).toContain('data-favicon-dark="/favicon-dark.ico"');
    expect(joined).toContain('data-favicon-dark="/favicon-dark-32x32.png"');
    expect(joined).toContain('data-favicon-dark="/favicon-dark-16x16.png"');
  });

  it("keeps the worktree favicon fixed so the scheme swap never touches it", () => {
    const links = renderFaviconLinks(
      getWorktreeUiBranding({
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
        PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
      }),
    );
    expect(links).not.toContain("data-favicon-light");
    expect(links).not.toContain("data-favicon-dark");
  });

  it("matches the default favicon block shipped in ui/index.html", () => {
    const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    const html = readFileSync(resolve(repoRoot, "ui/index.html"), "utf8");
    const block = html.slice(
      html.indexOf("<!-- PAPERCLIP_FAVICON_START -->"),
      html.indexOf("<!-- PAPERCLIP_FAVICON_END -->"),
    );
    const shipped = block
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
    expect(shipped).toBe(renderFaviconLinks(getWorktreeUiBranding({})));
  });
});
