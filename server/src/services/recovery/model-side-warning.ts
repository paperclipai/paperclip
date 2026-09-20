/**
 * A degraded provider turn can "succeed" at the process level while emitting
 * nothing but harness/CLI warnings as its output. Paperclip persists that
 * output as an agent-authored comment, and the GGU-809 stranded-recovery
 * exemption (`hasRecentVisibleProgress`) treats any recent agent comment as
 * evidence of progress. When the only comment is a boilerplate model-side
 * warning, that exemption never trips: the repeated-productive-continuation
 * circuit breaker is suppressed on every cycle and recovery re-queues an
 * `issue_continuation_needed` wake roughly once a minute — an unbounded,
 * real-cost loop with no possible resolution (observed in production with a
 * codex_local owner stuck emitting the skill-context-budget warning plus the
 * high-demand notice).
 *
 * These comment bodies carry no work-product evidence, so they must not count
 * as "visible progress". The matcher is intentionally narrow: it only ignores a
 * comment when *every* non-empty line is a recognized model-side/harness
 * warning, so a real progress note that merely mentions a warning still counts.
 */
const MODEL_SIDE_WARNING_LINE_PATTERNS: readonly RegExp[] = [
  // codex CLI skills-context-budget notice (emitted verbatim as the run output).
  /^warning:\s*skill descriptions were shortened to fit the skills context budget\b/i,
  // Generic skills-context truncation notice variants.
  /^warning:\s*(?:the\s+)?skills? (?:descriptions? (?:were|was) )?(?:shortened|truncated)\b/i,
  // Transient provider / high-demand notices surfaced as run output.
  /^we(?:'|’)re currently experiencing high demand\b/i,
  /^temporary errors? (?:may|might) occur\b/i,
];

export function isNonSubstantiveModelWarningComment(body: string): boolean {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) =>
    MODEL_SIDE_WARNING_LINE_PATTERNS.some((pattern) => pattern.test(line)),
  );
}
