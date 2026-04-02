/**
 * Changelog file updater
 * Appends new entries to CHANGELOG.md while preserving existing entries
 */

import * as fs from "fs";
import * as path from "path";
import type { ChangelogEntry } from "./types.js";

/**
 * Append a new changelog entry to the CHANGELOG.md file
 * Creates the file if it doesn't exist
 * Inserts new entry at the top (newest first)
 */
export function appendToChangelog(
  changelogPath: string,
  newEntry: ChangelogEntry
): void {
  try {
    // Ensure directory exists
    const dir = path.dirname(changelogPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Read existing changelog or create header
    let existingContent = "";
    if (fs.existsSync(changelogPath)) {
      existingContent = fs.readFileSync(changelogPath, "utf-8");

      // Validate existing file is readable and not malformed
      if (existingContent.trim().length > 0) {
        validateChangelogFormat(existingContent);
      }
    } else {
      // Create header for new file
      existingContent = generateChangelogHeader();
    }

    // Prepare new entry
    const newEntryMarkdown = newEntry.markdown;

    // Combine: header (if new file) + new entry + existing entries
    const updatedContent = combineChangelogContent(existingContent, newEntryMarkdown);

    // Write updated changelog
    fs.writeFileSync(changelogPath, updatedContent, "utf-8");
  } catch (error) {
    throw new Error(
      `Failed to update changelog at ${changelogPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Validate changelog format
 * Throws error if file appears malformed
 */
function validateChangelogFormat(content: string): void {
  const lines = content.split("\n");

  // Check for basic markdown structure
  if (!content.includes("##") && !content.includes("#")) {
    throw new Error(
      "Changelog file appears malformed: no markdown headers found"
    );
  }

  // Check that file isn't suspiciously short
  if (lines.length < 3 && content.trim().length > 0) {
    // Only warn if there's some content
    // Could be an empty or minimal changelog
  }
}

/**
 * Generate changelog header for new files
 */
function generateChangelogHeader(): string {
  return `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

`;
}

/**
 * Combine changelog content: insert new entry after header, before existing entries
 */
function combineChangelogContent(
  existingContent: string,
  newEntryMarkdown: string
): string {
  // Find where the first version entry starts (after header)
  const versionPattern = /^## v\d+\.\d+\.\d+/m;
  const firstVersionMatch = existingContent.match(versionPattern);

  let result = existingContent;

  if (firstVersionMatch && firstVersionMatch.index !== undefined) {
    // Insert before first existing version entry
    const insertIndex = firstVersionMatch.index;
    result =
      existingContent.substring(0, insertIndex) +
      newEntryMarkdown +
      "\n" +
      existingContent.substring(insertIndex);
  } else {
    // No existing versions, append at end
    result = existingContent + newEntryMarkdown;
  }

  return result;
}

/**
 * Extract version number from changelog entry markdown
 * Used for validation and ordering
 */
export function extractVersionFromEntry(markdown: string): string | null {
  const match = markdown.match(/^## (v\d+\.\d+\.\d+)/m);
  return match ? match[1] : null;
}

/**
 * Find a specific version in changelog
 * Returns the entry markdown and its position
 */
export function findVersionInChangelog(
  changelogPath: string,
  version: string
): { found: boolean; entry: string | null; lineNumber: number } {
  if (!fs.existsSync(changelogPath)) {
    return { found: false, entry: null, lineNumber: -1 };
  }

  const content = fs.readFileSync(changelogPath, "utf-8");
  const lines = content.split("\n");

  // Find version header
  const versionHeaderRegex = new RegExp(`^## ${version}`, "");
  const headerLineIndex = lines.findIndex((line) =>
    versionHeaderRegex.test(line)
  );

  if (headerLineIndex === -1) {
    return { found: false, entry: null, lineNumber: -1 };
  }

  // Find end of this entry (next version or end of file)
  let endLineIndex = lines.length;
  for (let i = headerLineIndex + 1; i < lines.length; i++) {
    if (/^## v\d+\.\d+\.\d+/.test(lines[i])) {
      endLineIndex = i;
      break;
    }
  }

  const entry = lines.slice(headerLineIndex, endLineIndex).join("\n");

  return {
    found: true,
    entry,
    lineNumber: headerLineIndex,
  };
}

/**
 * Update metadata in changelog entry
 * Used for appending release URLs and links after initial creation
 */
export function updateChangelogEntryMetadata(
  changelogPath: string,
  version: string,
  metadata: { releaseUrl?: string; date?: string }
): void {
  if (!fs.existsSync(changelogPath)) {
    throw new Error(`Changelog not found at ${changelogPath}`);
  }

  let content = fs.readFileSync(changelogPath, "utf-8");
  const versionPattern = new RegExp(`^## ${version}\\s*\\(([^)]*)\\)`, "m");

  if (metadata.date) {
    content = content.replace(versionPattern, `## ${version} (${metadata.date})`);
  }

  if (metadata.releaseUrl) {
    // Add link after version header
    const headerPattern = new RegExp(
      `(^## ${version}\\s*\\([^)]*\\))`,
      "m"
    );
    content = content.replace(
      headerPattern,
      `$1\n[Release](${metadata.releaseUrl})`
    );
  }

  fs.writeFileSync(changelogPath, content, "utf-8");
}
