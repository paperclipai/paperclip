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
