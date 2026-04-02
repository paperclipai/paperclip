/**
 * Tests for changelog updater
 */

import * as fs from "fs";
import * as path from "path";
import { appendToChangelog, findVersionInChangelog } from "./changelog-updater.js";
import type { ChangelogEntry } from "./types.js";

describe("appendToChangelog", () => {
  const tempDir = path.join(__dirname, ".test-temp");
  const changelogPath = path.join(tempDir, "CHANGELOG.md");

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  const mockEntry: ChangelogEntry = {
    version: "v2026.090.0",
    date: "2026-03-31",
    summary: "First release",
    featuresShipped: [
      {
        title: "Feature 1",
        description: "First feature",
        qaScore: 9,
        engineer: "alice",
        taskId: "T1",
      },
    ],
    featuresDropped: [],
    breakingChanges: [],
    contributors: ["alice"],
    sprintId: "sprint-1",
    markdown: "## v2026.090.0 (2026-03-31)\n\nFirst release\n",
  };

  test("should create new CHANGELOG.md if not exists", () => {
    expect(fs.existsSync(changelogPath)).toBe(false);

    appendToChangelog(changelogPath, mockEntry);

    expect(fs.existsSync(changelogPath)).toBe(true);
    const content = fs.readFileSync(changelogPath, "utf-8");
    expect(content).toContain("## v2026.090.0");
  });

  test("should create directories if they don't exist", () => {
    const nestedPath = path.join(tempDir, "a", "b", "c", "CHANGELOG.md");

    appendToChangelog(nestedPath, mockEntry);

    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  test("should include changelog header in new file", () => {
    appendToChangelog(changelogPath, mockEntry);

    const content = fs.readFileSync(changelogPath, "utf-8");
    expect(content).toContain("# Changelog");
    expect(content).toContain("Keep a Changelog");
  });

  test("should insert new entry at top of existing changelog", () => {
    // Create initial changelog
    const oldEntry: ChangelogEntry = {
      ...mockEntry,
      version: "v2026.089.0",
      date: "2026-03-30",
      markdown: "## v2026.089.0 (2026-03-30)\n\nOld release\n",
    };

    appendToChangelog(changelogPath, oldEntry);

    // Add new entry
    appendToChangelog(changelogPath, mockEntry);

    const content = fs.readFileSync(changelogPath, "utf-8");
    const newIndex = content.indexOf("v2026.090.0");
    const oldIndex = content.indexOf("v2026.089.0");

    expect(newIndex).toBeLessThan(oldIndex);
  });

  test("should preserve existing entries", () => {
    const oldEntry: ChangelogEntry = {
      ...mockEntry,
      version: "v2026.089.0",
      date: "2026-03-30",
      markdown: "## v2026.089.0 (2026-03-30)\n\nOld release\n",
    };

    appendToChangelog(changelogPath, oldEntry);
    appendToChangelog(changelogPath, mockEntry);

    const content = fs.readFileSync(changelogPath, "utf-8");
    expect(content).toContain("v2026.089.0");
    expect(content).toContain("v2026.090.0");
  });

  test("should handle malformed changelog", () => {
    // Create a bad changelog
    fs.writeFileSync(changelogPath, "This is not a valid changelog\n\nJust random text");

    // Should throw error
    expect(() => {
      appendToChangelog(changelogPath, mockEntry);
    }).toThrow("malformed");
  });

  test("should throw error on write permission issues", () => {
    // Create file with read-only permissions
    fs.writeFileSync(changelogPath, "# Changelog\n", "utf-8");
    fs.chmodSync(changelogPath, 0o444);

    // This test may not work on all systems
    // Skip if we can't set permissions
    const canTestPermissions = fs.statSync(changelogPath).mode & 0o200 === 0;

    if (canTestPermissions) {
      expect(() => {
        appendToChangelog(changelogPath, mockEntry);
      }).toThrow();
    }

    // Restore permissions for cleanup
    fs.chmodSync(changelogPath, 0o644);
  });
});

describe("findVersionInChangelog", () => {
  const tempDir = path.join(__dirname, ".test-temp-find");
  const changelogPath = path.join(tempDir, "CHANGELOG.md");

  beforeEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  test("should find version in changelog", () => {
    const content = `# Changelog

## v2026.090.0 (2026-03-31)

Feature 1

## v2026.089.0 (2026-03-30)

Feature 2
`;
    fs.writeFileSync(changelogPath, content);

    const result = findVersionInChangelog(changelogPath, "v2026.090.0");

    expect(result.found).toBe(true);
    expect(result.entry).toContain("v2026.090.0");
    expect(result.entry).toContain("Feature 1");
  });

  test("should return not found for missing version", () => {
    const content = `# Changelog

## v2026.090.0 (2026-03-31)

Feature 1
`;
    fs.writeFileSync(changelogPath, content);

    const result = findVersionInChangelog(changelogPath, "v2026.099.0");

    expect(result.found).toBe(false);
    expect(result.entry).toBeNull();
  });

  test("should return not found if changelog doesn't exist", () => {
    const result = findVersionInChangelog(changelogPath, "v2026.090.0");

    expect(result.found).toBe(false);
  });

  test("should include line number", () => {
    const content = `# Changelog

## v2026.090.0 (2026-03-31)

Feature 1
`;
    fs.writeFileSync(changelogPath, content);

    const result = findVersionInChangelog(changelogPath, "v2026.090.0");

    expect(result.lineNumber).toBeGreaterThanOrEqual(0);
  });

  test("should handle multiple versions correctly", () => {
    const content = `# Changelog

## v2026.090.0 (2026-03-31)

Feature A
Feature B

## v2026.089.0 (2026-03-30)

Feature C

## v2026.088.0 (2026-03-29)

Feature D
`;
    fs.writeFileSync(changelogPath, content);

    const result1 = findVersionInChangelog(changelogPath, "v2026.090.0");
    const result2 = findVersionInChangelog(changelogPath, "v2026.089.0");
    const result3 = findVersionInChangelog(changelogPath, "v2026.088.0");

    expect(result1.found).toBe(true);
    expect(result2.found).toBe(true);
    expect(result3.found).toBe(true);

    expect(result1.lineNumber).toBeLessThan(result2.lineNumber);
    expect(result2.lineNumber).toBeLessThan(result3.lineNumber);
  });
});
