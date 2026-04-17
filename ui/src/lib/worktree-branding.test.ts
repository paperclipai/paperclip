import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getWorktreeUiBranding } from "./worktree-branding.js";

// getWorktreeUiBranding reads from HTML meta tags via document.querySelector.
// In tests we mock global.document to exercise the pure branding/color logic.

// Helper to create a mock document that returns specific meta tag values.
function mockDocument(data: Record<string, string | undefined>): void {
  (global as Record<string, unknown>).document = {
    querySelector: (selector: string) => {
      const match = selector.match(/meta\[name="([^"]+)"\]/);
      if (!match) return null;
      const name = match[1]!;
      const content = data[name];
      if (content === undefined) return null;
      return { getAttribute: (_attr: string) => content };
    },
  };
}

describe("getWorktreeUiBranding", () => {
  const origDocument = (global as Record<string, unknown>).document;

  afterEach(() => {
    (global as Record<string, unknown>).document = origDocument;
  });

  // ── no document ───────────────────────────────────────────────────────────

  it("returns null when document is undefined (node env)", () => {
    // global.document is undefined in node environment by default
    expect((global as Record<string, unknown>).document).toBeUndefined();
    expect(getWorktreeUiBranding()).toBeNull();
  });

  // ── meta tag checks ───────────────────────────────────────────────────────

  it("returns null when paperclip-worktree-enabled is not 'true'", () => {
    mockDocument({ "paperclip-worktree-enabled": "false" });
    expect(getWorktreeUiBranding()).toBeNull();
  });

  it("returns null when paperclip-worktree-enabled meta tag is absent", () => {
    mockDocument({});
    expect(getWorktreeUiBranding()).toBeNull();
  });

  it("returns null when name meta tag is missing even if enabled", () => {
    mockDocument({
      "paperclip-worktree-enabled": "true",
      "paperclip-worktree-color": "#336699",
    });
    expect(getWorktreeUiBranding()).toBeNull();
  });

  it("returns null when color meta tag is missing even if enabled", () => {
    mockDocument({
      "paperclip-worktree-enabled": "true",
      "paperclip-worktree-name": "my-worktree",
    });
    expect(getWorktreeUiBranding()).toBeNull();
  });

  it("returns null when color is not a valid hex value", () => {
    mockDocument({
      "paperclip-worktree-enabled": "true",
      "paperclip-worktree-name": "my-worktree",
      "paperclip-worktree-color": "not-a-hex",
    });
    expect(getWorktreeUiBranding()).toBeNull();
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns branding object with enabled=true when all required fields are set", () => {
    mockDocument({
      "paperclip-worktree-enabled": "true",
      "paperclip-worktree-name": "feature-branch",
      "paperclip-worktree-color": "#336699",
    });
    const result = getWorktreeUiBranding();
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.name).toBe("feature-branch");
    expect(result!.color).toBe("#336699");
  });

  it("normalizes 6-digit hex color to lowercase", () => {
    mockDocument({
      "paperclip-worktree-enabled": "true",
      "paperclip-worktree-name": "test",
      "paperclip-worktree-color": "#AABBCC",
    });
    const result = getWorktreeUiBranding();
    expect(result!.color).toBe("#aabbcc");
  });

  it("normalizes 3-digit hex color to 6-digit lowercase", () => {
    mockDocument({
      "paperclip-worktree-enabled": "true",
      "paperclip-worktree-name": "test",
      "paperclip-worktree-color": "#abc",
    });
    const result = getWorktreeUiBranding();
    expect(result!.color).toBe("#aabbcc");
  });

  it("accepts hex color without leading #", () => {
    mockDocument({
      "paperclip-worktree-enabled": "true",
      "paperclip-worktree-name": "test",
      "paperclip-worktree-color": "336699",
    });
    const result = getWorktreeUiBranding();
    expect(result!.color).toBe("#336699");
  });

  // ── text color selection (WCAG contrast) ─────────────────────────────────

  it("uses light text color (#f8fafc) for dark background", () => {
    // Very dark background: #111111 has near-zero luminance → white text wins
    mockDocument({
      "paperclip-worktree-enabled": "true",
      "paperclip-worktree-name": "dark",
      "paperclip-worktree-color": "#111111",
    });
    const result = getWorktreeUiBranding();
    expect(result!.textColor).toBe("#f8fafc");
  });

  it("uses dark text color (#111827) for light background", () => {
    // Very light background: #eeeeee has near-max luminance → black text wins
    mockDocument({
      "paperclip-worktree-enabled": "true",
      "paperclip-worktree-name": "light",
      "paperclip-worktree-color": "#eeeeee",
    });
    const result = getWorktreeUiBranding();
    expect(result!.textColor).toBe("#111827");
  });

  it("uses dark text for white background", () => {
    mockDocument({
      "paperclip-worktree-enabled": "true",
      "paperclip-worktree-name": "white",
      "paperclip-worktree-color": "#ffffff",
    });
    const result = getWorktreeUiBranding();
    expect(result!.textColor).toBe("#111827");
  });

  it("uses light text for black background", () => {
    mockDocument({
      "paperclip-worktree-enabled": "true",
      "paperclip-worktree-name": "black",
      "paperclip-worktree-color": "#000000",
    });
    const result = getWorktreeUiBranding();
    expect(result!.textColor).toBe("#f8fafc");
  });

  // ── explicit text color override ──────────────────────────────────────────

  it("uses explicitly set text color when provided and valid", () => {
    mockDocument({
      "paperclip-worktree-enabled": "true",
      "paperclip-worktree-name": "test",
      "paperclip-worktree-color": "#336699",
      "paperclip-worktree-text-color": "#ff0000",
    });
    const result = getWorktreeUiBranding();
    expect(result!.textColor).toBe("#ff0000");
  });

  it("falls back to computed text color when explicit text color is invalid", () => {
    mockDocument({
      "paperclip-worktree-enabled": "true",
      "paperclip-worktree-name": "test",
      "paperclip-worktree-color": "#000000",
      "paperclip-worktree-text-color": "not-valid",
    });
    const result = getWorktreeUiBranding();
    // Invalid text color → falls back to computed contrast color (light for black bg)
    expect(result!.textColor).toBe("#f8fafc");
  });

  // ── edge: color values without # ─────────────────────────────────────────

  it("handles short 3-digit hex without # prefix", () => {
    mockDocument({
      "paperclip-worktree-enabled": "true",
      "paperclip-worktree-name": "test",
      "paperclip-worktree-color": "fff",
    });
    const result = getWorktreeUiBranding();
    expect(result!.color).toBe("#ffffff");
    expect(result!.textColor).toBe("#111827"); // dark text on white bg
  });
});
