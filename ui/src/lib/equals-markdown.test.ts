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
      // A line of `=` under text is a heading underline.
      "Title\n\\=\\=\\=",
      "Title\n\\=",
      "> Title\n> \\=\\=",
      "- item\n  \\=",
      // The exporter escapes a leading `>` too; it still starts the line.
      "\\> Title\n\\> \\=\\=\\=",
      "\\> Title\n\\> \\=\\=  ",
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
    // Pairs cut off by a code span do not see whitespace at the chunk edge.
    unchanged("x \\=\\=`code`\\=\\= y");
  });

  it("keeps an escape after an escaped backslash and removes it after an odd run", () => {
    // `\\\=` is an escaped backslash followed by an escaped `=`; only the `=` escape goes.
    expect(unescapeEqualsSigns("a\\\\\\=b")).toBe("a\\\\=b");
    unchanged("a\\\\=b");
  });

  it("stays linear on one long line with many assignments", () => {
    const line = Array.from({ length: 25_000 }, (_, index) => `k${index}\\=v`).join(" ");
    const started = performance.now();
    expect(unescapeEqualsSigns(line)).toBe(line.replaceAll("\\=", "="));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("leaves text without escaped equals untouched", () => {
    unchanged("plain a=b");
    unchanged("");
  });
});
