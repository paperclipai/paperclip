import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, parse } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Lexical must resolve to exactly one copy across the app and the rich editor.
 *
 * The editor registers the app's own nodes (mention-aware links, paste
 * handling) into MDXEditor's Lexical instance. If the app and MDXEditor load
 * different copies — or different versions of the same package — Lexical's
 * `LexicalBuilder` invariant throws during render, the editor falls back to
 * its raw-source textarea, and every markdown field in the product silently
 * degrades.
 *
 * That is not hypothetical: root `pnpm.overrides` once force-pinned the
 * Lexical family past the range `@mdxeditor/editor` supports, while leaving
 * `@lexical/extension` (absent from the override list) on the older line. The
 * mismatch shipped and broke the editor everywhere. These assertions fail
 * fast on the resolution graph instead of waiting for a render crash.
 */
describe("lexical single copy", () => {
  const requireFromUi = createRequire(import.meta.url);
  const mdxEditorEntry = requireFromUi.resolve("@mdxeditor/editor");
  const requireFromMdxEditor = createRequire(mdxEditorEntry);

  /** These packages block "./package.json" in exports, so read it off disk. */
  function manifestOf(specifier: string, from: NodeJS.Require): { version: string; dependencies?: Record<string, string> } {
    let dir = dirname(from.resolve(specifier));
    const { root } = parse(dir);
    while (true) {
      try {
        return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      } catch {
        if (dir === root) throw new Error(`no package.json above ${specifier}`);
        dir = dirname(dir);
      }
    }
  }

  function versionOf(specifier: string, from: NodeJS.Require): string {
    return manifestOf(specifier, from).version;
  }

  it("resolves the same lexical copy for the app and the editor", () => {
    expect(requireFromMdxEditor.resolve("lexical")).toBe(requireFromUi.resolve("lexical"));
  });

  it("keeps the app's lexical packages on the editor's version line", () => {
    const core = versionOf("lexical", requireFromUi);
    // @lexical/link carries the mention-aware LinkNode the app subclasses, so
    // a version split here breaks node identity even with one core copy.
    expect(versionOf("@lexical/link", requireFromUi)).toBe(core);
    expect(versionOf("lexical", requireFromMdxEditor)).toBe(core);
    // @lexical/extension owns the LexicalBuilder invariant that throws on a
    // mixed graph, and it is reached transitively rather than declared.
    expect(versionOf("@lexical/extension", requireFromMdxEditor)).toBe(core);
  });

  it("satisfies the editor's declared lexical range", () => {
    const declared = manifestOf("@mdxeditor/editor", requireFromUi).dependencies?.lexical;
    const [major, minor] = versionOf("lexical", requireFromUi).split(".");
    // A caret range on a 0.x version pins the minor: ^0.48.0 means <0.49.0.
    expect(declared).toBe(`^${major}.${minor}.0`);
  });
});
