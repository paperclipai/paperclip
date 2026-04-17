import { describe, it, expect } from "vitest";
import { resolveProjectNameForUniqueShortname } from "../services/projects.js";

// Minimal project row type — matches the private ProjectShortnameRow interface.
function makeProject(id: string, name: string): { id: string; name: string } {
  return { id, name };
}

describe("resolveProjectNameForUniqueShortname", () => {
  // ── no collision ──────────────────────────────────────────────────────────

  it("returns the requested name unchanged when no collisions exist", () => {
    const result = resolveProjectNameForUniqueShortname("My Project", []);
    expect(result).toBe("My Project");
  });

  it("returns the requested name unchanged when other projects have different slugs", () => {
    const existing = [makeProject("p1", "Other Project"), makeProject("p2", "Something Else")];
    const result = resolveProjectNameForUniqueShortname("My Project", existing);
    expect(result).toBe("My Project");
  });

  // ── collision → suffix ────────────────────────────────────────────────────

  it("appends ' 2' when the exact slug is already used", () => {
    const existing = [makeProject("p1", "My Project")];
    const result = resolveProjectNameForUniqueShortname("My Project", existing);
    expect(result).toBe("My Project 2");
  });

  it("appends ' 3' when ' 2' is also used", () => {
    const existing = [
      makeProject("p1", "My Project"),
      makeProject("p2", "My Project 2"),
    ];
    const result = resolveProjectNameForUniqueShortname("My Project", existing);
    expect(result).toBe("My Project 3");
  });

  it("skips to the first available suffix in a run of collisions", () => {
    const existing = [
      makeProject("p1", "Alpha"),
      makeProject("p2", "Alpha 2"),
      makeProject("p3", "Alpha 3"),
    ];
    const result = resolveProjectNameForUniqueShortname("Alpha", existing);
    expect(result).toBe("Alpha 4");
  });

  // ── excludeProjectId ──────────────────────────────────────────────────────

  it("excludes specified project from collision check", () => {
    // "My Project" is used by p1, but we're editing p1 itself → no collision
    const existing = [makeProject("p1", "My Project")];
    const result = resolveProjectNameForUniqueShortname("My Project", existing, {
      excludeProjectId: "p1",
    });
    expect(result).toBe("My Project");
  });

  it("still detects collision from other projects when one is excluded", () => {
    const existing = [
      makeProject("p1", "My Project"), // excluded
      makeProject("p2", "My Project"), // not excluded
    ];
    const result = resolveProjectNameForUniqueShortname("My Project", existing, {
      excludeProjectId: "p1",
    });
    expect(result).toBe("My Project 2");
  });

  // ── normalisation edge cases ──────────────────────────────────────────────

  it("returns requested name unchanged when normalisation produces empty slug", () => {
    // A name made entirely of non-alphanumeric non-ASCII chars normalizes to empty
    // Using a string that can't form a valid slug
    const result = resolveProjectNameForUniqueShortname("---", []);
    // normalizeProjectUrlKey("---") returns null → returns original name
    expect(result).toBe("---");
  });

  it("returns requested name unchanged for non-ASCII names (unique suffix from URL key)", () => {
    // hasNonAsciiContent returns true for names with non-ASCII chars
    const result = resolveProjectNameForUniqueShortname("Проект", []);
    expect(result).toBe("Проект");
  });

  it("is case-insensitive in collision detection (slugs are lowercased)", () => {
    // "MY PROJECT" and "My Project" normalize to the same slug: "my-project"
    const existing = [makeProject("p1", "MY PROJECT")];
    const result = resolveProjectNameForUniqueShortname("My Project", existing);
    expect(result).toBe("My Project 2");
  });

  // ── slug matching, not name matching ──────────────────────────────────────

  it("detects collision via slug equivalence even with different capitalization", () => {
    const existing = [makeProject("p1", "my project")];
    // "My Project" and "my project" both normalize to "my-project"
    const result = resolveProjectNameForUniqueShortname("My Project", existing);
    expect(result).toBe("My Project 2");
  });
});
