/** GitHub owns the bot identity; render its display name as plain heading text. */
export function githubReviewHeading(input: {
  botDisplayName: string | null;
  botUsername: string | null;
  agentName: string;
  score: number | null;
}) {
  const name = (input.botDisplayName?.trim() || input.botUsername?.replace(/\[bot\]$/, "").trim() || input.agentName)
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_[\]<>]/g, "\\$&");
  return `## ${name} — ${input.score === null ? "Incomplete" : `${input.score}/5`}`;
}

export function githubReviewSummary(input: Parameters<typeof githubReviewHeading>[0] & {
  summary: string;
  rationale: string;
}) {
  const heading = githubReviewHeading(input);
  const escapedLabel = heading.slice(0, heading.lastIndexOf(" — "));
  const plainLabel = escapedLabel.replace(/\\(.)/g, "$1");
  const labels = new Set([escapedLabel, plainLabel, "## Paperclip Review"]);
  const bodies = [input.summary, input.rationale].map(text => {
    let body = text.replace(/^(?:[ \t]*\r?\n)+/, "");
    while (body) {
      const newline = body.indexOf("\n");
      const line = (newline === -1 ? body : body.slice(0, newline)).trimEnd();
      const match = /^(## .+) — (?:[0-5]\/5|Incomplete)$/.exec(line);
      if (!match || !labels.has(match[1])) break;
      body = newline === -1 ? "" : body.slice(newline + 1).replace(/^(?:[ \t]*\r?\n)+/, "");
    }
    return body;
  });
  return [heading, ...bodies].filter(Boolean).join("\n\n");
}
