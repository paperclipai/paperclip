import { describe, expect, it } from "vitest";
import {
  escapeUnsupportedAngleBrackets,
  unescapeAngleBracketEscapes,
} from "./angle-bracket-markdown";

describe("escapeUnsupportedAngleBrackets", () => {
  it("leaves markdown without angle brackets untouched", () => {
    expect(escapeUnsupportedAngleBrackets("")).toBe("");
    expect(escapeUnsupportedAngleBrackets("plain prose")).toBe("plain prose");
  });

  it("escapes a placeholder written in prose", () => {
    expect(escapeUnsupportedAngleBrackets("Rename <name> to the real name")).toBe(
      "Rename \\<name> to the real name",
    );
  });

  it("escapes closing tags, comments and processing instructions", () => {
    expect(escapeUnsupportedAngleBrackets("a </close> b")).toBe("a \\</close> b");
    expect(escapeUnsupportedAngleBrackets("a <!-- note --> b")).toBe("a \\<!-- note --> b");
    expect(escapeUnsupportedAngleBrackets("a <?php b")).toBe("a \\<?php b");
  });

  it("escapes every eligible bracket on a line", () => {
    expect(escapeUnsupportedAngleBrackets("<a> and <b>")).toBe("\\<a> and \\<b>");
  });

  it("leaves a bracket that cannot open HTML alone", () => {
    expect(escapeUnsupportedAngleBrackets("Affected versions: <= v0.3.1")).toBe(
      "Affected versions: <= v0.3.1",
    );
    expect(escapeUnsupportedAngleBrackets("2 < 3 and 4 > 1")).toBe("2 < 3 and 4 > 1");
    expect(escapeUnsupportedAngleBrackets("a <1 b")).toBe("a <1 b");
    expect(escapeUnsupportedAngleBrackets("trailing <")).toBe("trailing <");
  });

  it("escapes a bracket next to one that cannot open HTML", () => {
    expect(escapeUnsupportedAngleBrackets("use <= or <name>")).toBe("use <= or \\<name>");
  });

  it("does not double-escape an already-escaped bracket", () => {
    expect(escapeUnsupportedAngleBrackets("Rename \\<name> here")).toBe("Rename \\<name> here");
  });

  it("escapes a bracket that follows a literal backslash", () => {
    // `\\` is an escaped backslash, so the `<` after it is still bare markup.
    expect(escapeUnsupportedAngleBrackets("a \\\\<name> b")).toBe("a \\\\\\<name> b");
  });

  it("skips inline code spans", () => {
    expect(escapeUnsupportedAngleBrackets("Use `<name>` here")).toBe("Use `<name>` here");
    expect(escapeUnsupportedAngleBrackets("Use ``a <b> c`` here")).toBe("Use ``a <b> c`` here");
  });

  it("escapes outside a code span on the same line", () => {
    expect(escapeUnsupportedAngleBrackets("`<a>` then <b>")).toBe("`<a>` then \\<b>");
  });

  it("treats an unmatched backtick as literal text, not a code span", () => {
    // CommonMark only forms a code span from a matched pair of equal-length
    // backtick runs, so the bracket after a lone backtick is still markup.
    expect(escapeUnsupportedAngleBrackets("a ` b <name> c")).toBe("a ` b \\<name> c");
    expect(escapeUnsupportedAngleBrackets("a ``b` c <name>")).toBe("a ``b` c \\<name>");
  });

  it("treats a backslash-escaped backtick as literal text", () => {
    expect(escapeUnsupportedAngleBrackets("a \\`x` b <name>")).toBe("a \\`x` b \\<name>");
  });

  it("skips a code span that wraps across a soft line break", () => {
    expect(escapeUnsupportedAngleBrackets("a `one\ntwo <x>` b <y>")).toBe(
      "a `one\ntwo <x>` b \\<y>",
    );
  });

  it("does not carry a code span across a blank line", () => {
    // A blank line ends the paragraph, so the opening backtick never matches.
    expect(escapeUnsupportedAngleBrackets("a `one <x>\n\ntwo` b <y>")).toBe(
      "a `one \\<x>\n\ntwo` b \\<y>",
    );
  });

  it("skips fenced code blocks", () => {
    expect(escapeUnsupportedAngleBrackets("```\n<name>\n```\n<after>")).toBe(
      "```\n<name>\n```\n\\<after>",
    );
    expect(escapeUnsupportedAngleBrackets("~~~ts\n<name>\n~~~")).toBe("~~~ts\n<name>\n~~~");
  });

  it("skips a fenced code block nested in a blockquote", () => {
    expect(escapeUnsupportedAngleBrackets("> ```\n> <name>\n> ```\n<after>")).toBe(
      "> ```\n> <name>\n> ```\n\\<after>",
    );
  });

  it("skips a fenced code block nested in a list", () => {
    expect(escapeUnsupportedAngleBrackets("- ```\n  <name>\n  ```\n<after>")).toBe(
      "- ```\n  <name>\n  ```\n\\<after>",
    );
  });

  it("does not close a fence on a shorter run of the same character", () => {
    expect(escapeUnsupportedAngleBrackets("````\n<a>\n```\n<b>\n````\n<c>")).toBe(
      "````\n<a>\n```\n<b>\n````\n\\<c>",
    );
  });

  it("skips indented code blocks", () => {
    expect(escapeUnsupportedAngleBrackets("intro\n\n    <name>\n\nafter <x>")).toBe(
      "intro\n\n    <name>\n\nafter \\<x>",
    );
    expect(escapeUnsupportedAngleBrackets("\t<name>")).toBe("\t<name>");
  });

  it("escapes an indented lazy paragraph continuation", () => {
    // Indented code cannot interrupt a paragraph, so this line is prose.
    expect(escapeUnsupportedAngleBrackets("para\n    more <name> here")).toBe(
      "para\n    more \\<name> here",
    );
  });

  it("escapes prose inside a blockquote but skips quoted indented code", () => {
    expect(escapeUnsupportedAngleBrackets("> Rename <name> here")).toBe(
      "> Rename \\<name> here",
    );
    expect(escapeUnsupportedAngleBrackets(">\n>     <name>")).toBe(">\n>     <name>");
  });

  it("skips autolinks", () => {
    expect(escapeUnsupportedAngleBrackets("See <https://example.com> for more")).toBe(
      "See <https://example.com> for more",
    );
    expect(escapeUnsupportedAngleBrackets("Mail <a.b@example.com> now")).toBe(
      "Mail <a.b@example.com> now",
    );
  });

  it("escapes a tag that only looks like an autolink", () => {
    expect(escapeUnsupportedAngleBrackets("<notascheme>")).toBe("\\<notascheme>");
  });

  it("skips pointed-bracket link destinations", () => {
    expect(escapeUnsupportedAngleBrackets("[a](<my file.md>)")).toBe("[a](<my file.md>)");
    expect(escapeUnsupportedAngleBrackets("![i](<f.png>)")).toBe("![i](<f.png>)");
  });

  it("still escapes prose around a pointed link destination", () => {
    expect(escapeUnsupportedAngleBrackets("[a](<f.md>) then <name>")).toBe(
      "[a](<f.md>) then \\<name>",
    );
  });

  it("is idempotent", () => {
    const inputs = [
      "Rename <name> to the real name",
      "Use `<name>` and <other>",
      "a \\\\<name> b",
      "```\n<name>\n```\n<after>",
      "See <https://example.com> and <name>",
      "[a](<f.md>) then <name>",
    ];
    for (const input of inputs) {
      const once = escapeUnsupportedAngleBrackets(input);
      expect(escapeUnsupportedAngleBrackets(once)).toBe(once);
    }
  });
});

describe("unescapeAngleBracketEscapes", () => {
  it("leaves markdown without escapes untouched", () => {
    expect(unescapeAngleBracketEscapes("")).toBe("");
    expect(unescapeAngleBracketEscapes("Rename <name> here")).toBe("Rename <name> here");
  });

  it("drops the backslash from an escaped html-like bracket", () => {
    expect(unescapeAngleBracketEscapes("Rename \\<name> here")).toBe("Rename <name> here");
    expect(unescapeAngleBracketEscapes("a \\</close> b")).toBe("a </close> b");
    expect(unescapeAngleBracketEscapes("a \\<!-- note --> b")).toBe("a <!-- note --> b");
    expect(unescapeAngleBracketEscapes("a \\<?php b")).toBe("a <?php b");
  });

  it("leaves an escape that does not hide an html construct alone", () => {
    expect(unescapeAngleBracketEscapes("a \\<= b")).toBe("a \\<= b");
    expect(unescapeAngleBracketEscapes("a \\<1 b")).toBe("a \\<1 b");
  });

  it("leaves other backslash escapes alone", () => {
    expect(unescapeAngleBracketEscapes("a \\> b and \\* c and \\<name>")).toBe(
      "a \\> b and \\* c and <name>",
    );
  });

  it("keeps backslash parity", () => {
    // `\\` is a literal backslash; the `<name>` after it is already bare.
    expect(unescapeAngleBracketEscapes("a \\\\<name> b")).toBe("a \\\\<name> b");
    // `\\` then `\<` is a literal backslash followed by an escaped bracket.
    expect(unescapeAngleBracketEscapes("a \\\\\\<name> b")).toBe("a \\\\<name> b");
  });

  it("keeps an escape that would otherwise open an autolink", () => {
    // `\<https://example.com>` renders as the literal text `<https://example.com>`.
    // Dropping the backslash would publish a link the author escaped on purpose,
    // and the escape half never escapes an autolink, so there is nothing to undo.
    expect(unescapeAngleBracketEscapes("See \\<https://example.com> here")).toBe(
      "See \\<https://example.com> here",
    );
    expect(unescapeAngleBracketEscapes("Mail \\<a.b@example.com> now")).toBe(
      "Mail \\<a.b@example.com> now",
    );
  });

  it("keeps an escape that would otherwise open a pointed link destination", () => {
    expect(unescapeAngleBracketEscapes("[a](\\<my file.md>)")).toBe("[a](\\<my file.md>)");
  });

  it("still unescapes a tag that only looks like an autolink", () => {
    expect(unescapeAngleBracketEscapes("\\<notascheme>")).toBe("<notascheme>");
    // The scheme needs at least two characters, so this is not an autolink.
    expect(unescapeAngleBracketEscapes("\\<x:y>")).toBe("<x:y>");
  });

  it("skips code spans and code blocks", () => {
    expect(unescapeAngleBracketEscapes("Use `\\<name>` here")).toBe("Use `\\<name>` here");
    expect(unescapeAngleBracketEscapes("```\n\\<name>\n```\n\\<after>")).toBe(
      "```\n\\<name>\n```\n<after>",
    );
    expect(unescapeAngleBracketEscapes("intro\n\n    \\<name>\n\nafter \\<x>")).toBe(
      "intro\n\n    \\<name>\n\nafter <x>",
    );
  });

  it("is idempotent", () => {
    const inputs = [
      "Rename \\<name> here",
      "a \\\\\\<name> b",
      "Use `\\<name>` and \\<other>",
      "```\n\\<name>\n```\n\\<after>",
    ];
    for (const input of inputs) {
      const once = unescapeAngleBracketEscapes(input);
      expect(unescapeAngleBracketEscapes(once)).toBe(once);
    }
  });
});

describe("angle bracket escape round trip", () => {
  const cases = [
    "Rename <name> to the real name",
    "Affected versions: <= v0.3.1",
    "5. python3 sync.py --input <tmp> -- writes insights/<group>/*.md",
    "a </close> and <!-- note --> and <?php",
    "Use `<name>` but not <other>",
    "```\n<name>\n```\n<after>",
    "intro\n\n    <name>\n\nafter <x>",
    "See <https://example.com> and mail <a@b.com>, then <name>",
    "[a](<my file.md>) then <name>",
    "a \\\\<name> b",
    "> quoted <name>",
    "- item <name>\n- other <x>",
    "para\n    more <name> here",
    "a `one\ntwo <x>` b <y>",
    "plain prose with no brackets",
    // An author's escaped autolink must survive an edit as literal text.
    "See \\<https://example.com> here",
    "Mail \\<a.b@example.com> now",
    "",
  ];

  it("returns the original markdown after escaping and unescaping", () => {
    for (const input of cases) {
      expect(unescapeAngleBracketEscapes(escapeUnsupportedAngleBrackets(input))).toBe(input);
    }
  });

  it("normalizes a pre-escaped bracket to its clean form", () => {
    // `\<name>` and `<name>` are the same literal text; the clean form is what
    // this product stores, and the rewrite only happens on a real edit.
    expect(unescapeAngleBracketEscapes(escapeUnsupportedAngleBrackets("Rename \\<name>"))).toBe(
      "Rename <name>",
    );
  });
});
