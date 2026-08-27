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

  type Triple = [number, number, number];

  function parseVersion(version: string): Triple {
    const [core] = version.split(/[-+]/);
    const parts = core.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 3 || parts.some(Number.isNaN)) {
      throw new Error(`cannot parse version "${version}"`);
    }
    return parts as Triple;
  }

  function compareVersions(a: Triple, b: Triple): number {
    for (let i = 0; i < 3; i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  }

  /**
   * Expand one range token into plain comparators.
   *
   * A caret on a 0.x version pins the minor, so `^0.48.0` becomes
   * `>=0.48.0 <0.49.0`. That rule is the whole reason this file exists:
   * `@mdxeditor/editor` declares `^0.48.0`, and 0.49.0 sits outside it.
   */
  function expand(token: string): Array<{ op: string; version: Triple }> {
    const caret = token.match(/^\^(.+)$/);
    if (caret) {
      const [major, minor, patch] = parseVersion(caret[1]);
      const upper: Triple = major > 0
        ? [major + 1, 0, 0]
        : minor > 0
          ? [0, minor + 1, 0]
          : [0, 0, patch + 1];
      return [{ op: ">=", version: [major, minor, patch] }, { op: "<", version: upper }];
    }

    const tilde = token.match(/^~(.+)$/);
    if (tilde) {
      const [major, minor, patch] = parseVersion(tilde[1]);
      return [
        { op: ">=", version: [major, minor, patch] },
        { op: "<", version: [major, minor + 1, 0] },
      ];
    }

    const comparator = token.match(/^(>=|<=|>|<|=)?\s*(\d.*)$/);
    if (!comparator) throw new Error(`cannot parse range token "${token}"`);
    return [{ op: comparator[1] ?? "=", version: parseVersion(comparator[2]) }];
  }

  /**
   * A deliberately small semver subset: caret, tilde, plain comparators, and
   * `||` unions. It covers every range shape npm packages use in practice, and
   * it throws on anything it does not understand rather than passing silently.
   * The alternative was a new `semver` dependency in `ui` for one assertion.
   */
  function satisfies(version: string, range: string): boolean {
    const target = parseVersion(version);
    return range.split("||").some((clause) => {
      const tokens = clause.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return false;
      return tokens.flatMap(expand).every(({ op, version: bound }) => {
        const order = compareVersions(target, bound);
        switch (op) {
          case ">=": return order >= 0;
          case "<=": return order <= 0;
          case ">": return order > 0;
          case "<": return order < 0;
          default: return order === 0;
        }
      });
    });
  }

  it("treats equivalent range spellings as equivalent", () => {
    // Guards the helper above: `^0.48.0` and its expanded form must agree, and
    // a 0.x caret must still exclude the next minor.
    for (const range of ["^0.48.0", ">=0.48.0 <0.49.0", "~0.48.0", "0.48.0", "^0.47.0 || ^0.48.0"]) {
      expect(satisfies("0.48.0", range), range).toBe(true);
      expect(satisfies("0.49.0", range), range).toBe(false);
    }
    expect(satisfies("0.48.3", "^0.48.0")).toBe(true);
    expect(satisfies("0.47.9", "^0.48.0")).toBe(false);
    expect(satisfies("1.5.0", "^1.2.3")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.3")).toBe(false);
    expect(() => satisfies("0.48.0", "workspace:*")).toThrow();
  });

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
    expect(declared, "@mdxeditor/editor must declare a lexical dependency").toBeTruthy();
    const resolved = versionOf("lexical", requireFromUi);
    // A root `pnpm.overrides` entry can force a single copy that still sits
    // outside the range the editor supports. The copy checks above would pass
    // in that case, so assert the range separately.
    expect(
      satisfies(resolved, declared!),
      `lexical ${resolved} does not satisfy the range "${declared}" that @mdxeditor/editor declares`,
    ).toBe(true);
  });
});
