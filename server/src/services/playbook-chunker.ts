import { logger } from "../middleware/logger.js";

/**
 * Minimal YAML frontmatter parser. Handles the subset our PLAYBOOK_STANDARD.md
 * uses: scalar values (strings, numbers, booleans), inline arrays [a, b, c],
 * and block arrays. No nested objects, no anchors, no multi-line strings.
 *
 * Inlined to avoid adding js-yaml as a runtime dep just for this.
 */
function parseFrontmatterYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;

    // Block array continuation: "  - value"
    if (currentArrayKey && /^\s+-\s+/.test(line)) {
      const item = line.replace(/^\s+-\s+/, "").trim();
      const arr = out[currentArrayKey] as unknown[];
      arr.push(coerceScalar(item));
      continue;
    }

    // Top-level "key: value"
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) {
      currentArrayKey = null;
      continue;
    }
    const key = m[1];
    const valueRaw = m[2];

    if (valueRaw === "" || valueRaw === undefined) {
      // Block array follows on next lines
      out[key] = [];
      currentArrayKey = key;
      continue;
    }

    currentArrayKey = null;

    // Inline array: [a, b, c]
    if (valueRaw.startsWith("[") && valueRaw.endsWith("]")) {
      const inner = valueRaw.slice(1, -1).trim();
      out[key] = inner === "" ? [] : inner.split(",").map((s) => coerceScalar(s.trim()));
      continue;
    }

    out[key] = coerceScalar(valueRaw);
  }
  return out;
}

function coerceScalar(s: string): string | number | boolean | null {
  // Strip surrounding quotes
  const unquoted = s.replace(/^["'](.*)["']$/, "$1");
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (unquoted === "null" || unquoted === "~") return null;
  if (/^-?\d+$/.test(unquoted)) return parseInt(unquoted, 10);
  if (/^-?\d+\.\d+$/.test(unquoted)) return parseFloat(unquoted);
  return unquoted;
}

/**
 * Parse a playbook markdown body into chunks, one per H2 section.
 *
 * Input format (per ~/.claude/standards/PLAYBOOK_STANDARD.md):
 *   - Optional YAML frontmatter between --- delimiters
 *   - H1 title line (# Title)
 *   - H2 sections (## Heading) each becoming one chunk
 *   - H3+ stays inside its parent H2 chunk
 *
 * The frontmatter is parsed and returned separately so callers can
 * denormalize fields (department, owner_role, audience) onto each chunk.
 *
 * Chunks are emitted in document order. The first chunk is typically
 * TL;DR, followed by Core Principles, then domain sections.
 */

export interface PlaybookFrontmatter {
  title?: string;
  slug?: string;
  department?: string;
  owner_role?: string;
  audience?: string;
  document_type?: string;
  version?: string;
  tags?: string[];
  chunk_strategy?: string;
  [key: string]: unknown;
}

export interface PlaybookChunk {
  anchor: string;       // "#tldr", "#core-principles", "#cost-attribution-model"
  heading: string;      // "TL;DR"
  headingPath: string;  // "CFO Playbook > TL;DR"
  body: string;         // markdown body of this H2 section (excluding the heading line)
  tokenCount: number;   // rough token estimate (chars / 4)
  orderNum: number;
}

export interface ParsedPlaybook {
  frontmatter: PlaybookFrontmatter;
  titleH1: string | null;
  chunks: PlaybookChunk[];
}

// Convert a heading to a GitHub-style anchor (lowercase, dashes, strip non-alnum).
function slugifyHeading(h: string): string {
  return (
    "#" +
    h
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
  );
}

// Rough token count: ~4 chars per token for English prose. Good enough
// for budget decisions; real counts come from the LLM's prompt_eval_count.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function parsePlaybook(body: string): ParsedPlaybook {
  let remaining = body;
  let frontmatter: PlaybookFrontmatter = {};

  // Extract YAML frontmatter if present
  const fmMatch = remaining.match(/^---\n([\s\S]+?)\n---\n/);
  if (fmMatch) {
    try {
      const parsed = parseFrontmatterYaml(fmMatch[1]) as PlaybookFrontmatter;
      if (parsed && typeof parsed === "object") {
        frontmatter = parsed;
      }
    } catch (err) {
      logger.warn({ err }, "playbook-chunker: failed to parse frontmatter");
    }
    remaining = remaining.slice(fmMatch[0].length);
  }

  // Extract H1 title
  let titleH1: string | null = null;
  const h1Match = remaining.match(/^#\s+(.+?)\n/);
  if (h1Match) {
    titleH1 = h1Match[1].trim();
    remaining = remaining.slice(h1Match[0].length);
  }

  // Split by H2 boundaries. We capture the heading and the content
  // between this H2 and the next H2 (or EOF).
  //
  // Note: markdown H2 can appear inside fenced code blocks (```). We must
  // NOT treat those as chunk boundaries. Strip fenced blocks from the scan
  // text, but preserve them in the emitted body.
  const chunks: PlaybookChunk[] = [];
  const titlePrefix = frontmatter.title || titleH1 || "Playbook";

  // Tokenize line-by-line, tracking fenced-block state.
  const lines = remaining.split("\n");
  let inFence = false;
  let currentHeading: string | null = null;
  let currentLines: string[] = [];
  let orderNum = 0;

  const flush = () => {
    if (currentHeading === null) return; // nothing to flush
    const chunkBody = currentLines.join("\n").trim();
    if (chunkBody.length === 0 && currentHeading.length === 0) return;

    const anchor = slugifyHeading(currentHeading);
    chunks.push({
      anchor,
      heading: currentHeading,
      headingPath: `${titlePrefix} > ${currentHeading}`,
      body: chunkBody,
      tokenCount: estimateTokens(chunkBody) + estimateTokens(currentHeading),
      orderNum,
    });
    orderNum += 1;
  };

  for (const line of lines) {
    // Detect fence toggle (``` or ~~~)
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      currentLines.push(line);
      continue;
    }

    // Only treat ## as H2 if NOT inside a fenced block
    const h2Match = !inFence && line.match(/^##\s+(.+?)\s*$/);
    if (h2Match) {
      flush();
      currentHeading = h2Match[1].trim();
      currentLines = [];
      continue;
    }

    // Preamble before first H2 (e.g., intro paragraph) is ignored for chunking
    // unless a heading has been seen. This aligns with the playbook standard
    // where TL;DR is always the first H2.
    if (currentHeading !== null) {
      currentLines.push(line);
    }
  }
  flush();

  return { frontmatter, titleH1, chunks };
}

/**
 * Validate a parsed playbook against the PLAYBOOK_STANDARD.md requirements.
 * Returns an array of warnings (empty if compliant).
 */
export function validatePlaybook(parsed: ParsedPlaybook): string[] {
  const warnings: string[] = [];
  const { frontmatter, chunks } = parsed;

  if (!frontmatter.title) warnings.push("missing frontmatter.title");
  if (!frontmatter.slug) warnings.push("missing frontmatter.slug");
  if (!frontmatter.department) warnings.push("missing frontmatter.department");
  if (chunks.length === 0) {
    warnings.push("no H2 chunks found");
    return warnings;
  }

  const headings = chunks.map((c) => c.heading.toLowerCase());
  if (!headings.includes("tl;dr") && !headings.includes("tldr")) {
    warnings.push("missing TL;DR section");
  }
  if (!headings.some((h) => h.startsWith("core principles"))) {
    warnings.push("missing Core Principles section");
  }
  if (!headings.some((h) => h.startsWith("anti-pattern"))) {
    warnings.push("missing Anti-Patterns section");
  }

  // Flag oversized chunks (standard says ~2000 tokens; we warn >3000)
  for (const chunk of chunks) {
    if (chunk.tokenCount > 3000) {
      warnings.push(`chunk "${chunk.heading}" is ${chunk.tokenCount} tokens (oversized, consider splitting)`);
    }
  }

  return warnings;
}
