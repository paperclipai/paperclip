import { chatCatalogHumanQuestionPolicies } from "../chat-catalog-contract.js";
import { askUserQuestionsPayloadSchema } from "../../../packages/shared/src/validators/issue.js";

/**
 * The product's own run presentation decision when a run ends its turn on a card:
 * the card, not a comment, is the conversation response for that run.
 */
export const INTERACTION_OWNS_RESPONSE = "interaction_owns_conversation_response";

export interface TurnResponseCard {
  id: string;
  kind: "ask_user_questions" | "request_confirmation";
  runId: string;
  /** Title, summary, prompts, details and choice labels a person reads on the card. */
  text: string;
  /** The exact record a confirmation card asks the person to review, when it names one. */
  target?: Record<string, unknown>;
}

interface RunLike { id: string; agentId?: string; status?: string; resultJson?: Record<string, unknown> | null }
type Row = Record<string, unknown>;
const record = (value: unknown): Row | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const strings = (...values: unknown[]) => values.filter((value): value is string => typeof value === "string" && !!value.trim());

// Every field a card can show a person: prompts, headers, help, labels, descriptions and placeholders,
// from the question form the page shows. Ids, schema names and keys are not shown.
const DISPLAYED = new Set(["title", "description", "prompt", "header", "helpText", "label", "placeholder", "submitLabel", "detailsMarkdown"]);
function displayedText(value: unknown, key?: string): string[] {
  if (typeof value === "string") return key && DISPLAYED.has(key) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(item => displayedText(item));
  const row = record(value);
  return row ? Object.entries(row).flatMap(([name, item]) => displayedText(item, name)) : [];
}

/** The page shows the canonical questionSet when present and the legacy questions otherwise; never both. */
function shownQuestionForm(payload: Row | undefined): Row | undefined {
  if (!payload) return payload;
  const { questions, questionSet, ...rest } = payload;
  return questionSet !== undefined ? { ...rest, questionSet } : { ...rest, questions };
}

/** True when the product decided that a card owns this run's conversation response. */
export function runEndedOnCard(run: RunLike): boolean {
  const decision = record(run.resultJson?.presentationDecision);
  return run.status === "succeeded" && Array.isArray(decision?.reasonCodes) && decision.reasonCodes.includes(INTERACTION_OWNS_RESPONSE);
}

/**
 * Pending cards that are a run's answer to the person: created by the lead's own run that ended
 * its turn on a card, still waiting for a human, and actually answerable (a question with a text
 * answer or at least two choices, or an ordinary accept/decline confirmation). Governed tool,
 * secret and connection approvals are excluded; their cases grade those workflows directly.
 */
export function turnResponseCards(input: { companyId: string; leadId: string; runs: readonly RunLike[]; interactions: readonly unknown[] }): TurnResponseCard[] {
  const runs = new Set(input.runs.filter(run => run.agentId === input.leadId && runEndedOnCard(run)).map(run => run.id));
  const cards: TurnResponseCard[] = [];
  for (const value of input.interactions) {
    const row = record(value);
    if (!row || typeof row.id !== "string" || row.status !== "pending" || row.companyId !== input.companyId
      || row.createdByAgentId !== input.leadId || row.createdByUserId || typeof row.sourceRunId !== "string" || !runs.has(row.sourceRunId)
      || row.dismissedAt || !chatCatalogHumanQuestionPolicies(row)) continue;
    const payload = record(row.payload);
    if (row.kind === "ask_user_questions") {
      const parsed = askUserQuestionsPayloadSchema.safeParse(payload);
      if (!parsed.success) continue;
      const answerable = parsed.data.questions.filter(question => !!question.prompt.trim()
        && (question.options.length >= 2 || question.options.some(option => option.freeText)));
      if (!answerable.length) continue;
      cards.push({ id: row.id, kind: "ask_user_questions", runId: row.sourceRunId, text: strings(row.title, row.summary, ...displayedText(shownQuestionForm(payload))).join("\n") });
    } else if (row.kind === "request_confirmation") {
      if (!payload || payload.toolAction || payload.secretProposal || payload.connectionAuthorization || typeof payload.prompt !== "string" || !payload.prompt.trim()) continue;
      cards.push({ id: row.id, kind: "request_confirmation", runId: row.sourceRunId,
        text: strings(row.title, row.summary, payload.prompt, payload.detailsMarkdown, payload.acceptLabel, payload.rejectLabel, payload.declineReasonPlaceholder).join("\n"),
        ...(record(payload.target) ? { target: record(payload.target) } : {}) });
    }
  }
  return cards;
}

/** The written reply plus the text of cards that answered the person in its place. */
export function replyOrCardText(reply: string, cards: readonly TurnResponseCard[]): string {
  return [reply, ...cards.map(card => card.text)].filter(text => !!text.trim()).join("\n");
}
