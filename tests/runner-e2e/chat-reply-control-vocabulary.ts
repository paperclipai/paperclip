import {
  PRP_BLOCK_RESULT_OUTPUT_SCHEMA,
  PRP_COMPLETION_RESULT_OUTPUT_SCHEMA,
  PRP_SEMANTIC_TOOL_NAMES,
} from "../../packages/paperclip-runner/src/contracts/completion-result.js";

/**
 * The agent's own completion vocabulary: the completion tool names and the
 * identifier-shaped field names of the completion report. These are setup
 * literals of the product, not wording; none of them belongs in a reply to a
 * person. A reply that holds one is the agent's planning or reasoning text.
 */
export const AGENT_CONTROL_TERMS: readonly string[] = (() => {
  const terms = new Set<string>(PRP_SEMANTIC_TOOL_NAMES);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "properties" && child && typeof child === "object")
        for (const name of Object.keys(child)) if (/^[a-z]+[A-Z][A-Za-z]*$/.test(name)) terms.add(name);
      visit(child);
    }
  };
  visit(PRP_COMPLETION_RESULT_OUTPUT_SCHEMA);
  visit(PRP_BLOCK_RESULT_OUTPUT_SCHEMA);
  return [...terms].sort();
})();

const TERM = new RegExp(`(?<![A-Za-z0-9_])(?:${AGENT_CONTROL_TERMS.join("|")})(?![A-Za-z0-9_])`, "g");

/** Agent control terms that appear in a reply, in order of first appearance. */
export function agentControlTermsInReply(text: string): string[] {
  return [...new Set(text.match(TERM) ?? [])];
}

/** Shared catalog check: no saved agent reply in the graded conversation holds agent control terms. */
export function chatReplyControlVocabularyCheck(input: {
  comments: ReadonlyArray<{ id: string; body: string; authorAgentId?: string | null; createdByRunId?: string | null }>;
  setupRunIds: readonly string[];
}): { id: string; passed: boolean; detail: string } {
  const setup = new Set(input.setupRunIds);
  const leaks = input.comments
    .filter((comment) => comment.authorAgentId && !(comment.createdByRunId && setup.has(comment.createdByRunId)))
    .map((comment) => ({ id: comment.id, terms: agentControlTermsInReply(comment.body) }))
    .filter((row) => row.terms.length > 0);
  return {
    id: "catalog-reply-no-agent-control-terms",
    passed: leaks.length === 0,
    detail: leaks.length
      ? `Agent replies hold completion tool or report field names: ${leaks.map((row) => `${row.id} (${row.terms.join(", ")})`).join("; ")}`
      : "No agent reply holds the agent's completion tool or report field names.",
  };
}
