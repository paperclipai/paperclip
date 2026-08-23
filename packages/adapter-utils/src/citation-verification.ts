// Mechanical verification of `file:line` evidence claims.
//
// 2026-08-23, from a live audit run (TSMC-21344). The task said, in terms:
// "Quote real file:line evidence — a claim without a path that exists is not
// evidence." The agent produced a 13-row table; 12 rows were exactly right and
// one was invented: it cited `gemini-local/src/server/execute.ts:269` for
// `createAcpxEngineExecutor`. That file contains no acpx reference at all, and
// gemini-local has no disposition parsing whatsoever — so the fabricated
// citation did not merely decorate a true claim, it manufactured a false one
// and hid a real gap behind it.
//
// The lesson is the one dispositions already taught: INSTRUCTION IS NOT
// ENFORCEMENT. Dispositions went from "please state one" to "parse it, and ask
// again in-session when it is missing", and capture went from ~26% to ~100%.
// Evidence needs the same arc, and this module is its parser.
//
// ⛔ The load-bearing detail: line 269 EXISTS. A file-and-line existence check
// passes the exact citation that was fabricated. Only checking that the cited
// location actually contains the claimed SYMBOL catches it. Any verifier that
// stops at "does the path resolve" provides false assurance — which is worse
// than none, because it launders a fabrication as checked.

/** A `path:line` (or `path:line,line,line`) claim found in agent output. */
export interface ExtractedCitation {
  /** Repo-relative path exactly as the agent wrote it. */
  path: string;
  /** Every line number attached to this path in one citation. */
  lines: number[];
  /** Backticked identifiers found near the citation — what it claims to show. */
  claimedSymbols: string[];
  /** Character offset of the match, for stable ordering and de-duplication. */
  index: number;
}

/**
 * Three states, not two — the distinction is the whole point.
 *
 * `refuted` is the alarm: the citation makes a checkable claim and the code
 * does not support it. That is the fabrication signal.
 *
 * `unchecked` is NOT an alarm: the citation names a location but no symbol to
 * check it against, so nothing was proven either way. Honest audit tables often
 * put the claim in one column and a bare path in the evidence column. Counting
 * those as failures produced 14-16 "failures" out of 22 on a real comment where
 * exactly one row was fabricated — a signal that noisy gets switched off, and
 * then it protects nothing. Same lesson as the test baseline: unmeasured is not
 * failed.
 */
export type CitationVerdict =
  | { status: "verified"; citation: ExtractedCitation; line: number; matchedSymbol: string }
  | { status: "refuted"; citation: ExtractedCitation; line: number; reason: string }
  | { status: "unchecked"; citation: ExtractedCitation; line: number; reason: string };

const PATH_LINE_RE =
  /(?:^|[\s`(\[|])([A-Za-z0-9._\-/]+\.(?:ts|tsx|js|mjs|cjs|json|md|sh|py|sql|yaml|yml)):(\d+(?:\s*,\s*\d+)*)/g;

// Identifiers a reviewer would recognise as a claim: `someFunction`,
// `CONSTANT_NAME`, `some_field`. Deliberately ignores prose in backticks.
const SYMBOL_RE = /`([A-Za-z_$][A-Za-z0-9_$]{2,})`/g;

/**
 * Symbols are read from the citation's OWN LINE only.
 *
 * The first version used a +/-320 character window. Measured against the real
 * audit comment that motivated this module, that produced 14 unverified of 22
 * — and only one was a genuine fabrication. In a markdown table a 320-char
 * window spans neighbouring ROWS, so another row's symbol bleeds in, crowds out
 * the correct one, and the honest row is flagged. A verifier that cries wolf on
 * true evidence gets switched off, and then it protects nothing. Same line: a
 * table row and ordinary prose both put the claim beside its citation.
 */
export const CITATION_SYMBOL_SCOPE = "same-line" as const;

/**
 * How close a backticked symbol must sit to a citation to count as its claim.
 * Tuned against the real audit comment: wide enough for "`sym` at path:12" and
 * "path:12 -> `sym`", narrow enough that a neighbouring citation's symbol on
 * the same table row is not attributed to this one.
 */
export const CITATION_SYMBOL_ADJACENCY_CHARS = 24;

/** How many lines either side of a cited line still count as showing it. */
export const CITATION_LINE_TOLERANCE = 3;

export function extractCitations(text: string): ExtractedCitation[] {
  if (!text) return [];
  const out: ExtractedCitation[] = [];
  PATH_LINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_LINE_RE.exec(text)) !== null) {
    const path = match[1];
    const lines = match[2]
      .split(",")
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (lines.length === 0) continue;

    // Attach only symbols ADJACENT to this citation, on its own line.
    //
    // Measured against the real audit comment: taking every symbol on the line
    // refuted 8 of 22 citations where one was actually fabricated, because a
    // long table row carries several citations and several symbols and the
    // wrong pairs get compared. A row reading "...execute.ts:269 ->
    // `createAcpxEngineExecutor`; engine imports the extractor at
    // acpx-engine/execute.ts:2" must not test line 2 against the symbol that
    // belongs to line 269.
    //
    // So: same line, and within CITATION_SYMBOL_ADJACENCY_CHARS of the
    // citation. When no symbol sits that close the citation is UNCHECKED, not
    // refuted. A conservative verifier that only fires when it is confident is
    // worth having; a noisy one gets switched off and then protects nothing.
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const lineEndRaw = text.indexOf("\n", match.index);
    const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
    const citeStartInLine = match.index - lineStart;
    const citeEndInLine = citeStartInLine + match[0].length;
    const line = text.slice(lineStart, lineEnd);
    const claimedSymbols: string[] = [];
    SYMBOL_RE.lastIndex = 0;
    let sym: RegExpExecArray | null;
    while ((sym = SYMBOL_RE.exec(line)) !== null) {
      const symStart = sym.index;
      const symEnd = sym.index + sym[0].length;
      const distance = symStart >= citeEndInLine
        ? symStart - citeEndInLine
        : citeStartInLine - symEnd;
      if (distance > CITATION_SYMBOL_ADJACENCY_CHARS) continue;
      if (!claimedSymbols.includes(sym[1])) claimedSymbols.push(sym[1]);
    }
    out.push({ path, lines, claimedSymbols, index: match.index });
  }
  return out;
}

export interface CitationVerificationDeps {
  /** Return the file's lines, or null when it does not exist / is unreadable. */
  readFileLines: (relativePath: string) => Promise<string[] | null>;
}

/**
 * Verify each cited line. A citation is VERIFIED only when the file resolves,
 * the line exists, and at least one claimed symbol appears within
 * CITATION_LINE_TOLERANCE lines of it. A citation with no claimed symbols
 * cannot be mechanically checked beyond existence and is reported as
 * unverified with that reason — silence is not proof.
 */
export async function verifyCitations(
  citations: ExtractedCitation[],
  deps: CitationVerificationDeps,
): Promise<CitationVerdict[]> {
  const verdicts: CitationVerdict[] = [];
  const fileCache = new Map<string, string[] | null>();

  for (const citation of citations) {
    if (!fileCache.has(citation.path)) {
      fileCache.set(citation.path, await deps.readFileLines(citation.path));
    }
    const lines = fileCache.get(citation.path) ?? null;

    for (const line of citation.lines) {
      if (lines === null) {
        // A path that does not resolve is a refutation, not a gap: the claim is
        // checkable and it failed.
        verdicts.push({ status: "refuted", citation, line, reason: "file_not_found" });
        continue;
      }
      if (line > lines.length) {
        verdicts.push({
          status: "refuted",
          citation,
          line,
          reason: `line_out_of_range (file has ${lines.length} lines)`,
        });
        continue;
      }
      if (citation.claimedSymbols.length === 0) {
        verdicts.push({ status: "unchecked", citation, line, reason: "no_claimed_symbol_on_this_line" });
        continue;
      }
      const from = Math.max(0, line - 1 - CITATION_LINE_TOLERANCE);
      const to = Math.min(lines.length, line + CITATION_LINE_TOLERANCE);
      const window = lines.slice(from, to).join("\n");
      const matched = citation.claimedSymbols.find((symbol) => window.includes(symbol));
      if (matched) {
        verdicts.push({ status: "verified", citation, line, matchedSymbol: matched });
      } else {
        verdicts.push({
          status: "refuted",
          citation,
          line,
          reason: `claimed ${citation.claimedSymbols.slice(0, 4).join(", ")} but the cited location shows none of them`,
        });
      }
    }
  }
  return verdicts;
}

export interface CitationCheckSummary {
  total: number;
  verified: number;
  /** Checkable claims the code contradicts. This is the number to act on. */
  refuted: number;
  /** Citations with nothing to verify against — neutral, not a failure. */
  unchecked: number;
  /** Human-readable refutations, capped so a runaway comment cannot flood a row. */
  refutations: string[];
}

export const CITATION_FAILURE_REPORT_LIMIT = 20;

export function summarizeCitationVerdicts(verdicts: CitationVerdict[]): CitationCheckSummary {
  const refutations = verdicts
    .filter((v): v is Extract<CitationVerdict, { status: "refuted" }> => v.status === "refuted")
    .map((v) => `${v.citation.path}:${v.line} — ${v.reason}`);
  return {
    total: verdicts.length,
    verified: verdicts.filter((v) => v.status === "verified").length,
    refuted: refutations.length,
    unchecked: verdicts.filter((v) => v.status === "unchecked").length,
    refutations: refutations.slice(0, CITATION_FAILURE_REPORT_LIMIT),
  };
}
