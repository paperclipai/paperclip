import { describe, it, expect } from "vitest";
import {
  getAdapterLabel,
  getAdapterLabels,
  getAdapterDisplay,
  isKnownAdapterType,
} from "./adapter-display-registry.js";

// ---------------------------------------------------------------------------
// isKnownAdapterType
// ---------------------------------------------------------------------------

describe("isKnownAdapterType", () => {
  it("returns true for known built-in types", () => {
    expect(isKnownAdapterType("claude_local")).toBe(true);
    expect(isKnownAdapterType("codex_local")).toBe(true);
    expect(isKnownAdapterType("gemini_local")).toBe(true);
    expect(isKnownAdapterType("opencode_local")).toBe(true);
    expect(isKnownAdapterType("process")).toBe(true);
    expect(isKnownAdapterType("http")).toBe(true);
  });

  it("returns false for unknown external types", () => {
    expect(isKnownAdapterType("my_custom_adapter")).toBe(false);
    expect(isKnownAdapterType("droid_local")).toBe(false);
    expect(isKnownAdapterType("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAdapterLabel
// ---------------------------------------------------------------------------

describe("getAdapterLabel", () => {
  it("returns the known label with (local) suffix for claude_local", () => {
    expect(getAdapterLabel("claude_local")).toBe("Claude Code (local)");
  });

  it("returns the known label with (local) suffix for codex_local", () => {
    expect(getAdapterLabel("codex_local")).toBe("Codex (local)");
  });

  it("returns the known label with (local) suffix for gemini_local", () => {
    expect(getAdapterLabel("gemini_local")).toBe("Gemini CLI (local)");
  });

  it("returns the known label with (local) suffix for opencode_local", () => {
    expect(getAdapterLabel("opencode_local")).toBe("OpenCode (local)");
  });

  it("humanizes unknown local types and appends (local)", () => {
    const label = getAdapterLabel("droid_local");
    // "droid_local" → strip "_local" → "droid" → "Droid" → "Droid (local)"
    expect(label).toContain("Droid");
    expect(label).toContain("(local)");
  });

  it("humanizes unknown types without a known suffix", () => {
    const label = getAdapterLabel("my_custom_tool");
    expect(label).toContain("My");
    expect(label).toContain("Custom");
  });

  it("returns a non-empty string for any input", () => {
    expect(getAdapterLabel("unknown_adapter")).toBeTruthy();
    expect(typeof getAdapterLabel("foo")).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// getAdapterLabels
// ---------------------------------------------------------------------------

describe("getAdapterLabels", () => {
  it("returns a record of known adapter labels with type suffixes", () => {
    const labels = getAdapterLabels();
    expect(typeof labels).toBe("object");
    // _local types get (local) suffix appended
    expect(labels.claude_local).toBe("Claude Code (local)");
    expect(labels.codex_local).toBe("Codex (local)");
  });

  it("includes all well-known adapter types", () => {
    const labels = getAdapterLabels();
    const knownTypes = ["claude_local", "codex_local", "gemini_local", "opencode_local", "process", "http"];
    for (const type of knownTypes) {
      expect(labels).toHaveProperty(type);
      expect(typeof labels[type]).toBe("string");
      expect(labels[type].length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// getAdapterDisplay
// ---------------------------------------------------------------------------

describe("getAdapterDisplay", () => {
  it("returns display info with label and description for a known type", () => {
    const info = getAdapterDisplay("claude_local");
    expect(info.label).toBe("Claude Code");
    expect(typeof info.description).toBe("string");
    expect(info.description.length).toBeGreaterThan(0);
    expect(info.icon).toBeDefined();
  });

  it("returns display info for an unknown type with a humanized label", () => {
    const info = getAdapterDisplay("droid_local");
    expect(typeof info.label).toBe("string");
    expect(info.label.length).toBeGreaterThan(0);
    expect(typeof info.description).toBe("string");
    expect(info.icon).toBeDefined();
  });

  it("includes description 'External local adapter' for unknown _local type", () => {
    const info = getAdapterDisplay("droid_local");
    expect(info.description).toContain("local");
  });

  it("includes description 'External adapter' for unknown type without suffix", () => {
    const info = getAdapterDisplay("my_tool");
    expect(info.description).toContain("External");
  });

  it("claude_local is marked as recommended", () => {
    const info = getAdapterDisplay("claude_local");
    expect(info.recommended).toBe(true);
  });

  it("codex_local is marked as recommended", () => {
    const info = getAdapterDisplay("codex_local");
    expect(info.recommended).toBe(true);
  });
});
