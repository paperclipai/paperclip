export type ActionCardFamily =
  | "attention"
  | "request_confirmation"
  | "request_checkbox_confirmation"
  | "ask_user_questions"
  | "suggest_tasks"
  | "request_item_verdicts";

export interface ActionCardLanguageInput {
  family: ActionCardFamily;
  title?: string | null;
  prompt?: string | null;
  summary?: string | null;
  consequence?: string | null;
  nonEffect?: string | null;
  acceptLabel?: string | null;
  rejectLabel?: string | null;
  submitLabel?: string | null;
  primaryLabel?: string | null;
  secondaryLabel?: string | null;
  safetyFacts?: readonly string[];
  technicalDetails?: readonly string[];
}

export interface ActionCardLanguage {
  decision: string;
  consequence: string;
  nonEffect: string;
  primaryAction: string;
  secondaryAction: string | null;
  safetyFacts: string[];
  technicalDetails: string[];
}

const MACHINE_LANGUAGE = /(?:\/api\/|https?:\/\/|(?:^|\s)(?:~\/|\/(?:[\w.-]+\/)+)|\bAPI\b|\b(?:POST|PUT|PATCH|DELETE|GET)\s+(?:\/|[a-z][a-z0-9_-]*[._][a-z0-9_-]*)|\b(?:UUID|JSON|callback|effect(?:Type| metadata)?|target(?:Issue)?Id|parentId|clientKey|itemId|runId)\b|\btool(?:Name|Call)?\b\s*[:=]|\b(?:error|exception|errno)\s*[:=_-]|\b[A-Z]{2,}-\d+\b|\b[0-9a-f]{8,}\b|\b[a-z][a-z0-9]+_[a-z0-9_]+\b)/i;
const SAFETY_LANGUAGE = /(?:cost|price|budget|token|delete|deletion|remove|external|outside the company|private|privacy|personal|access|permission|send|write|irreversible|cannot be undone|permanent)/i;

const DEFAULTS: Record<ActionCardFamily, Omit<ActionCardLanguage, "safetyFacts" | "technicalDetails">> = {
  attention: {
    decision: "Review why this item needs attention.",
    consequence: "Opening it shows the current state and the next action.",
    nonEffect: "Reviewing it does not approve or change the item.",
    primaryAction: "Review item",
    secondaryAction: null,
  },
  request_confirmation: {
    decision: "Choose whether to approve this request.",
    consequence: "Agreeing will let the responsible agent continue with the proposed action.",
    nonEffect: "It will not approve anything beyond this request.",
    primaryAction: "Approve and continue",
    secondaryAction: "Request changes",
  },
  request_checkbox_confirmation: {
    decision: "Choose which items to include in this action.",
    consequence: "Agreeing will apply the action only to the items you select.",
    nonEffect: "It will leave every unselected item unchanged.",
    primaryAction: "Confirm selection",
    secondaryAction: "Request changes",
  },
  ask_user_questions: {
    decision: "Answer the questions so the work can move forward.",
    consequence: "Your answers will guide the responsible agent's next step.",
    nonEffect: "They will not change the work until you submit them.",
    primaryAction: "Submit answers",
    secondaryAction: "Cancel questions",
  },
  suggest_tasks: {
    decision: "Review the proposed tasks and choose whether to add them.",
    consequence: "Agreeing will add the selected tasks to this work queue.",
    nonEffect: "It will not start or complete those tasks yet.",
    primaryAction: "Add selected tasks",
    secondaryAction: "Decline suggestion",
  },
  request_item_verdicts: {
    decision: "Review each item and choose an outcome.",
    consequence: "Your choices will be applied item by item.",
    nonEffect: "Items you leave undecided will not be changed.",
    primaryAction: "Apply decisions",
    secondaryAction: "Leave undecided",
  },
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isMachineText(value: string | null | undefined): boolean {
  return Boolean(value?.trim() && MACHINE_LANGUAGE.test(value));
}

export function isActionCardTechnicalText(value: string | null | undefined): boolean {
  return isMachineText(value);
}

function outcomeLabel(
  family: ActionCardFamily,
  value: string | null | undefined,
  fallback: string,
): string {
  const label = value?.trim();
  if (!label || isMachineText(label)) return fallback;
  const lower = label.toLowerCase();
  if (/^(approve|confirm|accept|apply|continue)\b/.test(lower)) {
    if (family === "request_confirmation") return "Approve and continue";
    if (family === "suggest_tasks") return "Add selected tasks";
    if (family === "request_item_verdicts") return "Apply decisions";
  }
  if (/^(reject|deny|decline)\b/.test(lower)) {
    return family === "suggest_tasks" ? "Decline suggestion" : "Decline";
  }
  if (/request revision|request changes|revise/.test(lower)) return "Request changes";
  if (/delete|remove/.test(lower)) return label.replace(/[_-]+/g, " ").replace(/^./, (char) => char.toUpperCase());
  return label;
}

function safetyFactFor(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("private") && (lower.includes("external") || lower.includes("outside"))) {
    return "This involves private information being sent outside the company.";
  }
  if (lower.includes("delete") || lower.includes("deletion") || lower.includes("remove")) {
    return "This will permanently delete or remove the selected items.";
  }
  if (lower.includes("cost") || lower.includes("price") || lower.includes("budget") || lower.includes("token")) {
    return "This may affect the budget or incur a cost.";
  }
  if (lower.includes("access") || lower.includes("permission")) {
    return "This changes who can access the information or action.";
  }
  if (lower.includes("private") || lower.includes("privacy") || lower.includes("personal")) {
    return "This involves private or personal information.";
  }
  if (lower.includes("irreversible") || lower.includes("cannot be undone") || lower.includes("permanent")) {
    return "This cannot be undone.";
  }
  if (lower.includes("external") || lower.includes("outside the company") || lower.includes("send")) {
    return "This will make a change or send information outside Paperclip.";
  }
  return null;
}

function plainSource(input: ActionCardLanguageInput): string | null {
  for (const candidate of [input.title, input.prompt, input.summary]) {
    if (candidate?.trim() && !isMachineText(candidate)) return candidate.trim();
  }
  return null;
}

export function buildActionCardLanguage(input: ActionCardLanguageInput): ActionCardLanguage {
  const defaults = DEFAULTS[input.family];
  const sourceValues = [input.title, input.prompt, input.summary, input.consequence, input.nonEffect];
  const technicalDetails = unique([
    ...(input.technicalDetails ?? []),
    ...sourceValues.filter((value): value is string => Boolean(value && isMachineText(value))),
  ]);
  const explicitConsequence = input.consequence?.trim();
  const explicitNonEffect = input.nonEffect?.trim();
  const source = plainSource(input);
  const safetyFacts = unique([
    ...(input.safetyFacts ?? []).flatMap((fact) => {
      if (!isMachineText(fact)) return [fact];
      const safeFact = safetyFactFor(fact);
      return safeFact ? [safeFact] : [];
    }),
    ...(explicitConsequence && !isMachineText(explicitConsequence) && SAFETY_LANGUAGE.test(explicitConsequence)
      ? [explicitConsequence]
      : []),
    ...sourceValues
      .filter((value): value is string => Boolean(value && SAFETY_LANGUAGE.test(value)))
      .map(safetyFactFor)
      .filter((value): value is string => Boolean(value)),
  ]);

  return {
    decision: source ?? defaults.decision,
    consequence: explicitConsequence && !isMachineText(explicitConsequence)
      ? explicitConsequence
      : defaults.consequence,
    nonEffect: explicitNonEffect && !isMachineText(explicitNonEffect)
      ? explicitNonEffect
      : defaults.nonEffect,
    primaryAction: outcomeLabel(
      input.family,
      input.primaryLabel ?? input.acceptLabel ?? input.submitLabel,
      defaults.primaryAction,
    ),
    secondaryAction: outcomeLabel(
      input.family,
      input.secondaryLabel ?? input.rejectLabel,
      defaults.secondaryAction ?? "",
    ) || null,
    safetyFacts,
    technicalDetails,
  };
}
