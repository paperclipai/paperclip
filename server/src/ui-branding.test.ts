import { describe, expect, it } from "vitest";
import {
  isWorktreeUiBrandingEnabled,
  getWorktreeUiBranding,
  renderFaviconLinks,
  renderRuntimeBrandingMeta,
  applyUiBranding,
} from "./ui-branding.js";

// ============================================================================
// isWorktreeUiBrandingEnabled
// ============================================================================

describe("isWorktreeUiBrandingEnabled", () => {
  it("returns false when PAPERCLIP_IN_WORKTREE is not set", () => {
    expect(isWorktreeUiBrandingEnabled({})).toBe(false);
  });

  it("returns true when PAPERCLIP_IN_WORKTREE=true", () => {
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "true" })).toBe(true);
  });

  it("returns true when PAPERCLIP_IN_WORKTREE=1", () => {
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "1" })).toBe(true);
  });

  it("returns true when PAPERCLIP_IN_WORKTREE=yes", () => {
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "yes" })).toBe(true);
  });

  it("returns true when PAPERCLIP_IN_WORKTREE=on", () => {
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "on" })).toBe(true);
  });

  it("returns false when PAPERCLIP_IN_WORKTREE=false", () => {
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "false" })).toBe(false);
  });

  it("is case-insensitive for truthy values", () => {
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "TRUE" })).toBe(true);
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "Yes" })).toBe(true);
  });
});

// ============================================================================
// getWorktreeUiBranding
// ============================================================================

describe("getWorktreeUiBranding", () => {
  it("returns disabled branding when not in worktree", () => {
    const branding = getWorktreeUiBranding({});
    expect(branding.enabled).toBe(false);
    expect(branding.name).toBeNull();
    expect(branding.color).toBeNull();
  });

  it("returns enabled branding with name from PAPERCLIP_WORKTREE_NAME", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "My Worktree",
    });
    expect(branding.enabled).toBe(true);
    expect(branding.name).toBe("My Worktree");
  });

  it("falls back to PAPERCLIP_INSTANCE_ID when no name is set", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_INSTANCE_ID: "my-instance",
    });
    expect(branding.name).toBe("my-instance");
  });

  it("falls back to 'worktree' when neither name nor instance id is set", () => {
    const branding = getWorktreeUiBranding({ PAPERCLIP_IN_WORKTREE: "true" });
    expect(branding.name).toBe("worktree");
  });

  it("uses PAPERCLIP_WORKTREE_COLOR when set to a valid hex", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_COLOR: "#336699",
    });
    expect(branding.color).toBe("#336699");
  });

  it("returns a textColor that is either light or dark", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_COLOR: "#000000",
    });
    // Black background should produce white text
    expect(branding.textColor).toBeTruthy();
  });

  it("includes a faviconHref data URL when enabled", () => {
    const branding = getWorktreeUiBranding({ PAPERCLIP_IN_WORKTREE: "true" });
    expect(branding.faviconHref).toMatch(/^data:image\/svg\+xml,/);
  });
});

// ============================================================================
// renderFaviconLinks
// ============================================================================

describe("renderFaviconLinks", () => {
  it("returns default favicon links when branding is disabled", () => {
    const branding = getWorktreeUiBranding({});
    const result = renderFaviconLinks(branding);
    expect(result).toContain("favicon.ico");
    expect(result).toContain("favicon.svg");
  });

  it("returns branded favicon links when branding is enabled", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_COLOR: "#336699",
    });
    const result = renderFaviconLinks(branding);
    expect(result).toContain("data:image/svg+xml");
    expect(result).toContain('rel="icon"');
  });

  it("branded links do not include the standard favicon.ico", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_COLOR: "#ff0000",
    });
    const result = renderFaviconLinks(branding);
    expect(result).not.toContain("favicon.ico");
  });
});

// ============================================================================
// renderRuntimeBrandingMeta
// ============================================================================

describe("renderRuntimeBrandingMeta", () => {
  it("returns empty string when branding is disabled", () => {
    const branding = getWorktreeUiBranding({});
    expect(renderRuntimeBrandingMeta(branding)).toBe("");
  });

  it("includes worktree-enabled meta when branding is enabled", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "Test Worktree",
      PAPERCLIP_WORKTREE_COLOR: "#336699",
    });
    const result = renderRuntimeBrandingMeta(branding);
    expect(result).toContain('name="paperclip-worktree-enabled"');
    expect(result).toContain('content="true"');
  });

  it("includes worktree name in meta", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "Test Worktree",
    });
    const result = renderRuntimeBrandingMeta(branding);
    expect(result).toContain("Test Worktree");
    expect(result).toContain('name="paperclip-worktree-name"');
  });

  it("includes worktree color in meta", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_COLOR: "#336699",
    });
    const result = renderRuntimeBrandingMeta(branding);
    expect(result).toContain("#336699");
    expect(result).toContain('name="paperclip-worktree-color"');
  });

  it("escapes HTML special characters in the name", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: 'my <worktree> "test"',
    });
    const result = renderRuntimeBrandingMeta(branding);
    // HTML-escaped characters should appear in the output
    expect(result).not.toContain("<worktree>");
    expect(result).toContain("&lt;worktree&gt;");
  });
});

// ============================================================================
// applyUiBranding
// ============================================================================

describe("applyUiBranding", () => {
  const TEMPLATE = `<!DOCTYPE html>
<html>
<head>
<!-- PAPERCLIP_FAVICON_START -->
    default favicon
<!-- PAPERCLIP_FAVICON_END -->
<!-- PAPERCLIP_RUNTIME_BRANDING_START -->
<!-- PAPERCLIP_RUNTIME_BRANDING_END -->
</head>
</html>`;

  it("replaces favicon block with default links when not in worktree", () => {
    const result = applyUiBranding(TEMPLATE, {});
    expect(result).toContain("favicon.ico");
    expect(result).toContain("PAPERCLIP_FAVICON_START");
    expect(result).toContain("PAPERCLIP_FAVICON_END");
  });

  it("replaces favicon block with branded links when in worktree", () => {
    const result = applyUiBranding(TEMPLATE, {
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_COLOR: "#336699",
    });
    expect(result).toContain("data:image/svg+xml");
  });

  it("injects runtime branding meta when in worktree", () => {
    const result = applyUiBranding(TEMPLATE, {
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "My Worktree",
    });
    expect(result).toContain('name="paperclip-worktree-enabled"');
    expect(result).toContain("My Worktree");
  });

  it("leaves html unchanged when markers are missing", () => {
    const html = "<html><head></head></html>";
    const result = applyUiBranding(html, {});
    expect(result).toBe(html);
  });
});
