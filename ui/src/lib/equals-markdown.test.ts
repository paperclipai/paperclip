import { describe, expect, it } from "vitest";
import { unescapeEqualsSigns } from "./equals-markdown";

const unchanged = (value: string) => expect(unescapeEqualsSigns(value)).toBe(value);

describe("unescapeEqualsSigns", () => {
  it("restores `=` the person typed in commands, assignments and arrows", () => {
    expect(unescapeEqualsSigns("Run node -e 'const fs\\=require(\"fs\");x.map(a\\=>a)'"))
      .toBe("Run node -e 'const fs=require(\"fs\");x.map(a=>a)'");
    expect(unescapeEqualsSigns("Set KEY\\=value and a \\= b")).toBe("Set KEY=value and a = b");
    expect(unescapeEqualsSigns("strict x \\=\\=\\= y and x!\\=\\=\\=y")).toBe("strict x === y and x!===y");
    expect(unescapeEqualsSigns("compare a \\=\\= b")).toBe("compare a == b");
    expect(unescapeEqualsSigns("> quoted a\\=b\n\n- listed c\\=d")).toBe("> quoted a=b\n\n- listed c=d");
  });

  it("keeps `==` escaped wherever it could open or close a highlight", () => {
    for (const value of [
      "\\=\\=highlight\\=\\=",
      "a\\=\\=b",
      // `!==` before a letter can open a highlight, so it stays escaped.
      "x!\\=\\=y",
      "say \\=\\=this",
      "that\\=\\= now",
      "a\\\\=b",
    ]) unchanged(value);
  });

  it("keeps every code span and code block byte-identical", () => {
    for (const value of [
      "Use `a\\=b` literally",
      "```\nconst a\\=1\n```",
      "    indented a\\=b",
      "> ```\n> a\\=b\n> ```",
      "<span title=\"a\\=b\">x</span>",
    ]) unchanged(value);
    expect(unescapeEqualsSigns("prose a\\=b and `code a\\=b`")).toBe("prose a=b and `code a\\=b`");
  });

  it("leaves text without escaped equals untouched", () => {
    unchanged("plain a=b");
    unchanged("");
  });
});
