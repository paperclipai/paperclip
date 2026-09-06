/**
 * Pure helpers for the vault read-bridge example.
 *
 * These helpers compute what the bridge **would** render, given a
 * snapshot of the vault tree. They never read or write the vault
 * themselves — all vault I/O goes through the host's
 * `ctx.localFolders.readText` / `ctx.localFolders.list` surface so
 * the host's containment checks, symlink-escape guards, and the
 * `access: "read"` declaration all apply uniformly.
 */

/**
 * A note the bridge considers for rendering under a given project.
 *
 * The bridge never invents notes: every entry is a real file under
 * the configured vault root.
 */
export interface VaultNote {
  readonly relativePath: string;
  readonly title: string;
  readonly mtimeMs: number | null;
  readonly sizeBytes: number | null;
  readonly frontmatterProject: string | null;
  readonly backlinks: readonly string[];
}

export interface ProjectVaultContext {
  readonly projectId: string;
  /**
   * The project slug the bridge uses to look up vault notes. The
   * bridge looks under `30-Products/<productSlug>/` and treats any
   * note whose frontmatter `project:` tag matches the slug as
   * belonging to this project.
   */
  readonly productSlug: string;
}

const WIKILINK_PATTERN = /\[\[([^\]\n]+?)\]\]/g;

/**
 * Parse the YAML frontmatter of an Obsidian note and return the value
 * of the `project:` key, if any. The parser is intentionally minimal:
 * it supports only the flat `key: value` shape the vault uses; it
 * never invokes a YAML library because the bridge never executes
 * arbitrary frontmatter.
 */
export function parseFrontmatterProject(
  rawBody: string,
): string | null {
  if (!rawBody.startsWith("---")) return null;
  const end = rawBody.indexOf("\n---", 3);
  if (end < 0) return null;
  const frontmatterBlock = rawBody.slice(3, end);
  for (const line of frontmatterBlock.split(/\r?\n/)) {
    const match = /^project:\s*(.+?)\s*$/.exec(line);
    if (match) {
      const value = match[1].trim();
      // Strip surrounding quotes if present.
      const unquoted = value.replace(/^["'](.*)["']$/, "$1");
      return unquoted.length > 0 ? unquoted : null;
    }
  }
  return null;
}

/**
 * Resolve `[[wikilinks]]` against the vault only. We never resolve a
 * wikilink against Paperclip issues — the bridge is read-only and
 * does not cross into the issue tree.
 */
export function resolveWikilinks(
  rawBody: string,
  knownNoteTitles: ReadonlySet<string>,
): { readonly resolved: string[]; readonly unresolved: string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const match of rawBody.matchAll(WIKILINK_PATTERN)) {
    const raw = match[1];
    if (!raw) continue;
    // `[[Note Name|alias]]` and `[[Note Name#section]]` shapes.
    const base = raw.split("|")[0]?.split("#")[0]?.trim() ?? "";
    if (!base) continue;
    if (knownNoteTitles.has(base)) {
      resolved.push(base);
    } else {
      unresolved.push(base);
    }
  }
  return { resolved, unresolved };
}

/**
 * Score a vault note's relevance to a project.
 *
 * The relevance score is computed only from persisted vault state
 * (the note's relative path, frontmatter `project:` tag, and the
 * list of notes that backlink to it). The bridge never infers
 * relevance from timing.
 *
 * Returns a numeric score; higher means more relevant. Notes that
 * score zero are excluded from the project view.
 */
export function scoreNoteRelevance(
  note: VaultNote,
  context: ProjectVaultContext,
): number {
  let score = 0;
  // Direct: frontmatter `project:` tag matches the project slug.
  if (
    note.frontmatterProject !== null &&
    note.frontmatterProject.toLowerCase() === context.productSlug.toLowerCase()
  ) {
    score += 100;
  }
  // Subfolder: the note lives directly under the product subfolder.
  if (note.relativePath.startsWith(`30-Products/${context.productSlug}/`)) {
    score += 50;
  }
  // Backlinks: at least one note from `70-Reviews-and-Scorecards/` or
  // `60-Portfolio-Decisions/` references this note.
  if (note.backlinks.length > 0) {
    score += Math.min(note.backlinks.length * 5, 25);
  }
  return score;
}

/**
 * Apply the redaction surface from
 * `10-Portfolio/Sensitive Information Rules.md`.
 *
 * The prototype takes a flat allow-list of vault-relative paths
 * whose bodies must be replaced with a `[redacted]` placeholder. The
 * rules file is parsed once at startup; this function applies the
 * resulting allow-list to a single note body.
 */
export function applyRedaction(
  relativePath: string,
  body: string,
  redactedPaths: ReadonlySet<string>,
): string {
  if (!redactedPaths.has(relativePath)) return body;
  return "[redacted]\n";
}

export function isRedactionRulesPath(relativePath: string): boolean {
  return (
    relativePath === "10-Portfolio/Sensitive Information Rules.md" ||
    relativePath.endsWith("/Sensitive Information Rules.md")
  );
}
