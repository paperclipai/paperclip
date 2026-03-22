import { describe, expect, it } from "vitest";
import { parseManagedMarker } from "./execute.js";
import type { PaperclipManagedMarker } from "./execute.js";

// ---------------------------------------------------------------------------
// parseManagedMarker
// ---------------------------------------------------------------------------

describe("parseManagedMarker", () => {
  it("parses valid JSON marker", () => {
    const marker: PaperclipManagedMarker = { agentId: "a1", companyId: "c1", skillName: "foo" };
    expect(parseManagedMarker(JSON.stringify(marker))).toEqual(marker);
  });

  it("parses JSON marker with trailing newline", () => {
    const marker: PaperclipManagedMarker = { agentId: "a1", companyId: "c1", skillName: "foo" };
    expect(parseManagedMarker(JSON.stringify(marker) + "\n")).toEqual(marker);
  });

  it("returns null for legacy plain-text marker", () => {
    expect(parseManagedMarker("my-skill\n")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseManagedMarker("")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseManagedMarker("{bad json")).toBeNull();
  });

  it("returns null for JSON missing required fields", () => {
    expect(parseManagedMarker(JSON.stringify({ agentId: "a1" }))).toBeNull();
  });

  it("returns null for JSON with wrong field types", () => {
    expect(parseManagedMarker(JSON.stringify({ agentId: 123, companyId: "c1", skillName: "foo" }))).toBeNull();
  });
});
