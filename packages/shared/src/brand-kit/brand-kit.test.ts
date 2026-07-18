import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDesignMd } from "./parse.js";
import { serializeDesignMd } from "./serialize.js";
import { importStitchDesign } from "./stitch-import.js";
import { emitYaml, parseYaml } from "./yaml.js";

const here = dirname(fileURLToPath(import.meta.url));
const medSpaFixture = readFileSync(join(here, "__fixtures__/med-spa.design.md"), "utf8");

function expectOk(result: ReturnType<typeof parseDesignMd>) {
  if (!result.ok) {
    throw new Error(`expected parse to succeed, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.document;
}

describe("yaml subset parser/emitter", () => {
  it("parses nested mappings, scalar sequences, and sequences of mappings", () => {
    const value = parseYaml(
      [
        "name: Example",
        "tone:",
        "  - warm",
        "  - expert",
        "pairs:",
        "  - do: \"a\"",
        "    dont: \"b\"",
        "  - do: \"c\"",
        "    dont: \"d\"",
        "nested:",
        "  level: 2",
        "  flag: true",
      ].join("\n"),
    );
    expect(value).toEqual({
      name: "Example",
      tone: ["warm", "expert"],
      pairs: [
        { do: "a", dont: "b" },
        { do: "c", dont: "d" },
      ],
      nested: { level: 2, flag: true },
    });
  });

  it("round-trips emit→parse for sequences of mappings", () => {
    const original = {
      list: [
        { role: "logo_primary", src: "a.svg" },
        { role: "logo_mark", src: "b.svg" },
      ],
      scalars: ["one", "two"],
    };
    const text = emitYaml(original as never);
    expect(parseYaml(text)).toEqual(original);
  });

  it("distinguishes quoted strings from numbers and booleans", () => {
    const value = parseYaml(['size: "1.5"', "weight: 700", "flag: false"].join("\n"));
    expect(value).toEqual({ size: "1.5", weight: 700, flag: false });
  });
});

describe("parseDesignMd", () => {
  it("parses the med-spa fixture into structured tokens", () => {
    const doc = expectOk(parseDesignMd(medSpaFixture));
    expect(doc.tokens.name).toBe("Lumière Med Spa");
    expect(doc.tokens.colors.primary).toBe("#2E5E55");
    expect(doc.tokens.colors.secondary).toEqual({ 50: "#FBF1EE", 300: "#E7B7A8", 500: "#D08C73" });
    expect(doc.tokens.colors.semantic?.error).toBe("#B23A3A");
    expect(doc.tokens.typography?.scale.h1?.weight).toBe(600);
    expect(doc.tokens.zIndex?.modal).toBe(1300);
    expect(doc.tokens.voice?.dosAndDonts).toHaveLength(2);
    expect(doc.tokens.voice?.lexicon?.blacklist).toContain("miracle");
    expect(doc.tokens.assets?.logos?.[0]).toEqual({ role: "logo_primary", src: "assets/lumiere-logo.svg" });
    expect(doc.body).toContain("Lumière is clinical-luxe");
  });
});

describe("round-trip (acceptance: med-spa fixture round-trips)", () => {
  it("serialize→parse preserves the token model", () => {
    const first = expectOk(parseDesignMd(medSpaFixture));
    const serialized = serializeDesignMd(first);
    const second = expectOk(parseDesignMd(serialized));
    expect(second.tokens).toEqual(first.tokens);
    expect(second.body).toBe(first.body);
  });

  it("serialization is idempotent (stable bytes)", () => {
    const doc = expectOk(parseDesignMd(medSpaFixture));
    const once = serializeDesignMd(doc);
    const twice = serializeDesignMd(expectOk(parseDesignMd(once)));
    expect(twice).toBe(once);
  });
});

describe("structured validation errors", () => {
  it("flags a missing frontmatter fence", () => {
    const result = parseDesignMd("# Just prose, no frontmatter\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("missing_frontmatter");
  });

  it("flags a missing required name with a dotted path", () => {
    const result = parseDesignMd(['---', 'colors:', '  primary: "#112233"', '---', ''].join("\n"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.path === "name")).toBe(true);
  });

  it("flags an invalid hex color at colors.primary", () => {
    const result = parseDesignMd(['---', "name: X", 'colors:', '  primary: "not-a-color"', '---', ''].join("\n"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.path === "colors.primary")).toBe(true);
  });

  it("rejects unknown token categories (strict schema)", () => {
    const result = parseDesignMd(
      ['---', "name: X", 'colors:', '  primary: "#112233"', "bogusCategory: 1", '---', ''].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === "unrecognized_keys")).toBe(true);
  });
});

describe("Stitch→native import shim", () => {
  const stitchSource = [
    "---",
    "name: Acme MD3",
    "colors:",
    '  primary: "#6750A4"',
    '  secondary: "#625B71"',
    '  tertiary: "#7D5260"',
    '  error: "#B3261E"',
    '  surface: "#FFFBFE"',
    "typography:",
    "  displayLarge:",
    '    fontFamily: Roboto',
    '    fontSize: "57px"',
    "    fontWeight: 400",
    "  bodyLarge:",
    '    fontFamily: Roboto',
    '    fontSize: "16px"',
    "    fontWeight: 400",
    "shape:",
    '  medium: "12px"',
    '  full: "9999px"',
    "---",
    "",
    "MD3 brand doc.",
  ].join("\n");

  it("maps MD3 vocabulary into native roles and scale names", () => {
    const result = importStitchDesign(stitchSource);
    expect(result.ok).toBe(true);
    const tokens = result.document!.tokens;
    expect(tokens.colors.primary).toBe("#6750A4");
    // tertiary → accent, error → semantic.error, surface → neutral fallback
    expect(tokens.colors.accent).toBe("#7D5260");
    expect(tokens.colors.semantic?.error).toBe("#B3261E");
    expect(tokens.colors.neutral).toBe("#FFFBFE");
    // displayLarge → display, bodyLarge → body
    expect(tokens.typography?.scale.display?.family).toBe("Roboto");
    expect(tokens.typography?.scale.body?.size).toBe("16px");
    // shape medium → rounded.md, full → rounded.full
    expect(tokens.rounded?.md).toBe("12px");
    expect(tokens.rounded?.full).toBe("9999px");
  });

  it("produces a native document that round-trips through parse/serialize", () => {
    const imported = importStitchDesign(stitchSource);
    expect(imported.ok).toBe(true);
    const serialized = serializeDesignMd(imported.document!);
    const reparsed = parseDesignMd(serialized);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.document.tokens).toEqual(imported.document!.tokens);
  });

  it("is effectively a no-op on already-native vocabulary", () => {
    const native = expectOk(parseDesignMd(medSpaFixture));
    const reimported = importStitchDesign(serializeDesignMd(native));
    expect(reimported.ok).toBe(true);
    expect(reimported.document!.tokens.colors.primary).toBe("#2E5E55");
    expect(reimported.document!.tokens.colors.accent).toBe("#C9A24B");
  });
});
