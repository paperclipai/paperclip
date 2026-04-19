import { promises as fs } from "node:fs";
import path from "node:path";
import type { ObsidianNote } from "./mapper.js";

/**
 * Serialize a frontmatter object to YAML format.
 */
function serializeFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fm)) {
    if (value === null || value === undefined) {
      lines.push(`${key}: null`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${JSON.stringify(item)}`);
        }
      }
    } else if (typeof value === "string") {
      // Quote strings that contain special YAML characters
      if (/[:#{}[\],&*?|>!%@`]/.test(value) || value.includes("\n")) {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Render a complete Obsidian note with YAML frontmatter and markdown body.
 */
export function renderNote(note: ObsidianNote): string {
  const fm = serializeFrontmatter(note.frontmatter);
  return `---\n${fm}\n---\n\n${note.body}`;
}

/**
 * Write notes to the filesystem vault directory.
 * Creates directories as needed.
 * Returns the list of file paths written.
 */
export async function writeNotesToVault(vaultPath: string, notes: ObsidianNote[]): Promise<string[]> {
  const written: string[] = [];

  for (const note of notes) {
    const fullPath = path.join(vaultPath, note.relativePath);
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });
    const content = renderNote(note);
    await fs.writeFile(fullPath, content, "utf-8");
    written.push(fullPath);
  }

  return written;
}
