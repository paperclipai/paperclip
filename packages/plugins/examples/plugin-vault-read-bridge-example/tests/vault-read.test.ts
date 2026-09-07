/**
 * Tests use Node's built-in `node:test` runner so we do not depend
 * on the workspace vitest. The functions under test are pure and
 * have no external dependencies.
 */

import { describe, it } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
  applyRedaction,
  isRedactionRulesPath,
  parseFrontmatterProject,
  resolveWikilinks,
  scoreNoteRelevance,
  type VaultNote,
} from "../src/vault-read.ts";

function note(partial: Partial<VaultNote>): VaultNote {
  return {
    relativePath: partial.relativePath ?? "30-Products/Praxora/index.md",
    title: partial.title ?? "Praxora",
    mtimeMs: partial.mtimeMs ?? null,
    sizeBytes: partial.sizeBytes ?? null,
    frontmatterProject: partial.frontmatterProject ?? null,
    backlinks: partial.backlinks ?? [],
  };
}

describe("parseFrontmatterProject", () => {
  it("returns null for a note without frontmatter", () => {
    strictEqual(parseFrontmatterProject("# Title\nbody\n"), null);
  });

  it("returns the project value when present", () => {
    const raw = [
      "---",
      "title: Crevoro",
      "project: crevoro",
      "status: active",
      "---",
      "# body",
    ].join("\n");
    strictEqual(parseFrontmatterProject(raw), "crevoro");
  });

  it("returns null when the frontmatter has no project line", () => {
    const raw = ["---", "title: Crevoro", "---", "# body"].join("\n");
    strictEqual(parseFrontmatterProject(raw), null);
  });

  it("handles quoted frontmatter values", () => {
    const raw = ["---", 'project: "kinstory"', "---", "# body"].join("\n");
    strictEqual(parseFrontmatterProject(raw), "kinstory");
  });

  it("returns null for an empty project value", () => {
    const raw = ["---", "project: ", "---", "# body"].join("\n");
    strictEqual(parseFrontmatterProject(raw), null);
  });
});

describe("resolveWikilinks", () => {
  it("classifies resolved and unresolved wikilinks", () => {
    const titles = new Set(["Praxora", "Crevoro"]);
    const body = "see [[Praxora]] and [[Nonexistent]] for [[Crevoro | canonical]]";
    const result = resolveWikilinks(body, titles);
    deepStrictEqual(result.resolved.sort(), ["Crevoro", "Praxora"]);
    deepStrictEqual(result.unresolved, ["Nonexistent"]);
  });

  it("ignores empty wikilink matches", () => {
    const titles = new Set<string>();
    const body = "[[]] and [[ ]]";
    const result = resolveWikilinks(body, titles);
    deepStrictEqual(result.resolved, []);
    deepStrictEqual(result.unresolved, []);
  });
});

describe("scoreNoteRelevance", () => {
  const ctx = { projectId: "p1", productSlug: "Praxora" };

  it("scores a note under the product subfolder", () => {
    const note_ = note({ relativePath: "30-Products/Praxora/index.md" });
    ok(scoreNoteRelevance(note_, ctx) > 0);
  });

  it("scores a note with matching frontmatter project higher", () => {
    const direct = note({
      relativePath: "70-Reviews-and-Scorecards/review.md",
      frontmatterProject: "Praxora",
    });
    const subfolderOnly = note({
      relativePath: "30-Products/Praxora/index.md",
    });
    ok(scoreNoteRelevance(direct, ctx) > scoreNoteRelevance(subfolderOnly, ctx));
  });

  it("scores a note with no relation zero", () => {
    const unrelated = note({
      relativePath: "30-Products/KinStory/index.md",
      frontmatterProject: "kinstory",
    });
    strictEqual(scoreNoteRelevance(unrelated, ctx), 0);
  });

  it("caps the backlink score", () => {
    const linked = note({
      relativePath: "70-Reviews-and-Scorecards/review.md",
      backlinks: ["Praxora", "Praxora", "Praxora", "Praxora", "Praxora", "Praxora", "Praxora"],
    });
    ok(scoreNoteRelevance(linked, ctx) <= 75);
  });
});

describe("applyRedaction", () => {
  it("returns the body unchanged when the path is not redacted", () => {
    const body = "# body";
    strictEqual(applyRedaction("30-Products/Praxora/index.md", body, new Set()), body);
  });

  it("redacts a note whose path is in the allow-list", () => {
    const body = "# sensitive";
    const redacted = applyRedaction("10-Portfolio/secrets.md", body, new Set(["10-Portfolio/secrets.md"]));
    strictEqual(redacted, "[redacted]\n");
    ok(!redacted.includes("sensitive"));
  });
});

describe("isRedactionRulesPath", () => {
  it("matches the canonical path", () => {
    strictEqual(isRedactionRulesPath("10-Portfolio/Sensitive Information Rules.md"), true);
  });

  it("rejects unrelated paths", () => {
    strictEqual(isRedactionRulesPath("30-Products/Praxora/index.md"), false);
  });
});
