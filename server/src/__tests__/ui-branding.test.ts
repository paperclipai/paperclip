import { describe, expect, it } from "vitest";
import { applyUiBranding, isWorktreeUiBrandingEnabled, renderFaviconLinks } from "../ui-branding.js";

const TEMPLATE = `<!doctype html>
<head>
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

  it("renders the worktree favicon asset set when enabled", () => {
    const links = renderFaviconLinks(true);
    expect(links).toContain("/worktree-favicon.ico");
    expect(links).toContain("/worktree-favicon.svg");
    expect(links).toContain("/worktree-favicon-32x32.png");
    expect(links).toContain("/worktree-favicon-16x16.png");
  });

  it("rewrites the favicon block for worktree instances only", () => {
    const branded = applyUiBranding(TEMPLATE, { PAPERCLIP_IN_WORKTREE: "true" });
    expect(branded).toContain("/worktree-favicon.svg");
    expect(branded).not.toContain('href="/favicon.svg"');

    const defaultHtml = applyUiBranding(TEMPLATE, {});
    expect(defaultHtml).toContain('href="/favicon.svg"');
    expect(defaultHtml).not.toContain("/worktree-favicon.svg");
  });
});
