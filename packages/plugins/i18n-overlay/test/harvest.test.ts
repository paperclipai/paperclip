// @vitest-environment node
// (harvest is a pure Node tool; jsdom rebinds the global URL base to
//  http://localhost, which breaks fileURLToPath on import.meta.url.)
import { describe, it, expect } from "vitest";
import { extractStrings, mergeInto } from "../tools/harvest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sample = readFileSync(fileURLToPath(new URL("./fixtures/Sample.tsx", import.meta.url)), "utf8");

describe("harvest", () => {
  it("extracts JSX text and whitelisted attribute strings", () => {
    const out = extractStrings(sample);
    expect(out.text).toContain("Save changes");
    expect(out.attr).toContain("Search issues…");
    expect(out.text).not.toContain("dynamic");
  });

  it("merges without clobbering existing translations and seeds new keys empty", () => {
    const existing = { $meta: { language: "de", version: 1 }, text: { "Save changes": "Änderungen speichern" }, attr: {} };
    const merged = mergeInto(existing, { text: ["Save changes", "New label"], attr: ["Search issues…"] });
    expect(merged.text["Save changes"]).toBe("Änderungen speichern");
    expect(merged.text["New label"]).toBe("");
    expect(merged.attr["Search issues…"]).toBe("");
  });
});
