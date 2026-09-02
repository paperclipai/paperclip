import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MOTION_TOKENS } from "./motion-tokens";
import { buildTweakExport } from "./TweakPanel";

/** Collect declared --motion-* custom properties from index.css (deduped). */
function declaredMotionTokens(): Set<string> {
  const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
  const names = new Set<string>();
  const re = /(--motion-[a-z0-9-]+)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) names.add(m[1]);
  return names;
}

describe("motion token catalog", () => {
  it("is 1:1 with the --motion-* tokens declared in index.css", () => {
    const declared = declaredMotionTokens();
    const catalog = new Set(MOTION_TOKENS.map((t) => t.name));

    const missingFromCatalog = [...declared].filter((n) => !catalog.has(n));
    const missingFromCss = [...catalog].filter((n) => !declared.has(n));

    expect(missingFromCatalog, "tokens in index.css but not in the catalog").toEqual([]);
    expect(missingFromCss, "tokens in the catalog but not in index.css").toEqual([]);
    expect(catalog.size).toBe(declared.size);
  });
});

describe("tweak panel export", () => {
  it("emits a valid :root block containing every motion token", () => {
    const values: Record<string, string> = {};
    for (const t of MOTION_TOKENS) values[t.name] = t.kind === "time" ? "123ms" : "linear";
    const out = buildTweakExport(values);

    expect(out.startsWith(":root {")).toBe(true);
    expect(out.trimEnd().endsWith("}")).toBe(true);
    // Balanced braces.
    expect((out.match(/{/g) ?? []).length).toBe((out.match(/}/g) ?? []).length);
    // Every token present as a declaration.
    for (const t of MOTION_TOKENS) {
      expect(out).toContain(`${t.name}: ${values[t.name]};`);
    }
  });
});
