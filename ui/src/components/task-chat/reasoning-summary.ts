/**
 * Provider reasoning summaries arrive as sections. Codex writes each summary
 * part as a bold headline followed by optional prose ("**Checking test
 * layout**\n\nI'll look at…"), and the runner separates parts with a blank
 * line. Claude's summarized thinking is prose without headlines. This module
 * splits either shape into display sections without inventing any text.
 */
export interface ReasoningSummarySection {
  /** Provider-authored headline with its markdown emphasis removed. */
  headline: string | null;
  /** Remaining provider-authored prose for the section, if any. */
  body: string;
}

const HEADLINE = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/;
/** A headline whose closing emphasis has not streamed in yet. */
const STREAMING_HEADLINE = /^\s*(?:\*\*|__)([^*_]+)$/;

function cleanHeadline(text: string): string {
  return text.replace(/[*`]+/g, "").replace(/^_+|_+$/g, "").replace(/\s+/g, " ").trim();
}

/** Split reasoning text into headline sections; a headline line always starts a new section. */
export function reasoningSummarySections(text: string): ReasoningSummarySection[] {
  const sections: ReasoningSummarySection[] = [];
  let current: { headline: string | null; body: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const body = current.body.join("\n").trim();
    if (current.headline || body) sections.push({ headline: current.headline, body });
    current = null;
  };
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = HEADLINE.exec(line) ?? (index === lines.length - 1 ? STREAMING_HEADLINE.exec(line) : null);
    const headline = match ? cleanHeadline(match[1] ?? "") : "";
    if (headline) {
      flush();
      current = { headline, body: [] };
      continue;
    }
    if (!current) current = { headline: null, body: [] };
    current.body.push(line);
  }
  flush();
  return sections;
}

/** Whether the provider wrote section headlines (Codex) rather than plain prose. */
export function hasReasoningHeadlines(sections: readonly ReasoningSummarySection[]): boolean {
  return sections.some((section) => section.headline);
}

/** The newest provider headline, used as a live run's one-line status. */
export function latestReasoningHeadline(text: string): string | null {
  return reasoningSummarySections(text).findLast((section) => section.headline)?.headline ?? null;
}
