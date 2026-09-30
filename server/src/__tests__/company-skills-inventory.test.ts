import { describe, expect, it } from "vitest";

import { buildSkillFileInventory } from "../services/company-skills.ts";

describe("buildSkillFileInventory", () => {
  it("keeps sibling files when SKILL.md sits in a subdirectory", () => {
    const paths = [
      "skills/flutter/SKILL.md",
      "skills/flutter/references/architecture.md",
      "skills/flutter/templates/Makefile",
      "skills/other/SKILL.md",
    ];

    const inventory = buildSkillFileInventory(paths, "skills/flutter/SKILL.md");

    // Sorted with localeCompare, so "SKILL.md" lands between "references/" and
    // "templates/" rather than first.
    expect(inventory.map((entry) => entry.path)).toEqual([
      "references/architecture.md",
      "SKILL.md",
      "templates/Makefile",
    ]);
  });

  it("keeps sibling files when SKILL.md sits at the root of the scanned scope", () => {
    // An import URL pointing straight at the skill directory, or a local
    // directory that *is* the skill, yields paths relative to SKILL.md itself.
    // `path.posix.dirname("SKILL.md")` is ".", and the sibling test used to be
    // `entry.startsWith("./")`, which matches nothing — so the inventory
    // collapsed to SKILL.md and every asset was silently dropped.
    const paths = [
      "SKILL.md",
      "references/architecture.md",
      "references/testing-tdd.md",
      "templates/lib/core/error/failures.dart",
      "examples/favorites/README.md",
    ];

    const inventory = buildSkillFileInventory(paths, "SKILL.md");

    expect(inventory.map((entry) => entry.path)).toEqual([
      "examples/favorites/README.md",
      "references/architecture.md",
      "references/testing-tdd.md",
      "SKILL.md",
      "templates/lib/core/error/failures.dart",
    ]);
  });

  it("classifies each entry by kind", () => {
    const inventory = buildSkillFileInventory(
      ["SKILL.md", "references/architecture.md", "scripts/run.sh", "assets/logo.png", "notes.md"],
      "SKILL.md",
    );

    expect(Object.fromEntries(inventory.map((entry) => [entry.path, entry.kind]))).toEqual({
      "SKILL.md": "skill",
      "references/architecture.md": "reference",
      "scripts/run.sh": "script",
      "assets/logo.png": "asset",
      "notes.md": "markdown",
    });
  });

  it("returns only SKILL.md when the skill directory holds nothing else", () => {
    const inventory = buildSkillFileInventory(["SKILL.md"], "SKILL.md");

    expect(inventory).toEqual([{ path: "SKILL.md", kind: "skill" }]);
  });
});
