import { describe, expect, it } from "vitest";
import { unescapeIntrawordUnderscores } from "./underscore-markdown";

const unchanged = (value: string) => expect(unescapeIntrawordUnderscores(value)).toBe(value);

describe("unescapeIntrawordUnderscores", () => {
  it("restores underscores the person typed inside words and identifiers", () => {
    expect(unescapeIntrawordUnderscores("Reply with E2E\\_ASK\\_12\\_journey\\_1793913565974\\_507b01b8."))
      .toBe("Reply with E2E_ASK_12_journey_1793913565974_507b01b8.");
    expect(unescapeIntrawordUnderscores("Set PAPERCLIP\\_TASK\\_ID and snake\\_case")).toBe("Set PAPERCLIP_TASK_ID and snake_case");
    expect(unescapeIntrawordUnderscores("ünïcode\\_wörd")).toBe("ünïcode_wörd");
    expect(unescapeIntrawordUnderscores("foo\\_\\_bar and a\\_\\_\\_b")).toBe("foo__bar and a___b");
    expect(unescapeIntrawordUnderscores("> quoted snake\\_case\n\n- listed snake\\_case")).toBe("> quoted snake_case\n\n- listed snake_case");
  });

  it("keeps word-boundary escapes and escaped backslashes", () => {
    for (const value of [
      "\\_not emphasis\\_",
      // `__init__` at word boundaries would render as strong emphasis.
      "\\_\\_init\\_\\_",
      "word \\_start",
      "end\\_ word",
      "a\\\\_b",
    ]) unchanged(value);
  });

  it("keeps every code span and code block byte-identical", () => {
    for (const value of [
      "Use `snake\\_case` literally",
      "``keep\\_this ` inside``",
      "```\nE2E\\_ASK\n```",
      "~~~ts\nconst a\\_b = 1;\n~~~",
      "    indented\\_code",
      "> ```\n> snake\\_case\n> ```",
      "- ```\n  snake\\_case\n  ```",
      "1. ~~~\n   snake\\_case\n   ~~~",
      // Greptile: a fence indented inside a list item, closed at the item's indent.
      "- item\n\n    ```\n    keep\\_this\n         ```\n    still\\_code\n    ```",
      // A top-level fence whose content has a quoted fence-like line.
      "```\n> ```\nkeep\\_this\n```",
      "\\\\`snake\\_case`",
    ]) unchanged(value);
  });

  it("rewrites only the prose around code", () => {
    expect(unescapeIntrawordUnderscores("```\nkeep\\_this\n```\nfix\\_this")).toBe("```\nkeep\\_this\n```\nfix_this");
    expect(unescapeIntrawordUnderscores("> ```\n> keep\\_this\n> ```\n\nfix\\_this")).toBe("> ```\n> keep\\_this\n> ```\n\nfix_this");
    expect(unescapeIntrawordUnderscores("`keep\\_this` and fix\\_this")).toBe("`keep\\_this` and fix_this");
    expect(unescapeIntrawordUnderscores("\\\\`keep\\_this` then fix\\_this")).toBe("\\\\`keep\\_this` then fix_this");
    expect(unescapeIntrawordUnderscores("- item\n\n    ```\n    keep\\_this\n    ```\n\nfix\\_this"))
      .toBe("- item\n\n    ```\n    keep\\_this\n    ```\n\nfix_this");
  });

  it("treats escaped or unmatched backticks as text", () => {
    expect(unescapeIntrawordUnderscores("A literal \\` then snake\\_case")).toBe("A literal \\` then snake_case");
    expect(unescapeIntrawordUnderscores("An unmatched ` then snake\\_case")).toBe("An unmatched ` then snake_case");
  });
});
