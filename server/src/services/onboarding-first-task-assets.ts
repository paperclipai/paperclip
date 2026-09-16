import fs from "node:fs/promises";
import { z } from "zod";
import {
  askUserQuestionsPayloadSchema,
  askUserQuestionsQuestionOptionSchema,
  type AskUserQuestionsPayload,
} from "@paperclipai/shared";

// Everything the onboarding first agent is told lives as plain markdown under
// server/src/onboarding-assets/first-task/ so the board can edit the wording
// without touching TypeScript. These loaders read those files at runtime the
// same way loadDefaultAgentInstructionsBundle reads default/ and ceo/ (the build
// copies src/onboarding-assets/. into dist/onboarding-assets/), and fill the
// {{agentName}} / {{organizationName}} / {{proposalStep}} placeholders.

export interface OnboardingFirstTaskPlaceholders {
  agentName?: string | null;
  organizationName?: string | null;
}

// The opening card seeded on the first task right after the greeting: one
// single-select question with two options, "interview me" or "I have a task in
// mind" (free text). The brief refers to these ids, so they are fixed here;
// only the wording lives in opening-question.json.
export const ONBOARDING_FIRST_TASK_OPENING_QUESTION_ID = "first-task-opening";
export const ONBOARDING_FIRST_TASK_OPENING_INTERVIEW_OPTION_ID = "interview";
export const ONBOARDING_FIRST_TASK_OPENING_TASK_OPTION_ID = "task";

const openingQuestionFileSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  helpText: z.string().trim().max(4000).nullable().optional(),
  submitLabel: z.string().trim().max(120).nullable().optional(),
  options: z.array(askUserQuestionsQuestionOptionSchema).length(2),
}).superRefine((value, ctx) => {
  const ids = value.options.map((option) => option.id);
  if (!ids.includes(ONBOARDING_FIRST_TASK_OPENING_INTERVIEW_OPTION_ID)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `opening-question.json must keep an option with id "${ONBOARDING_FIRST_TASK_OPENING_INTERVIEW_OPTION_ID}"`,
      path: ["options"],
    });
  }
  const taskOption = value.options.find((option) => option.id === ONBOARDING_FIRST_TASK_OPENING_TASK_OPTION_ID);
  if (!taskOption) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `opening-question.json must keep an option with id "${ONBOARDING_FIRST_TASK_OPENING_TASK_OPTION_ID}"`,
      path: ["options"],
    });
  } else if (taskOption.freeText !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `the "${ONBOARDING_FIRST_TASK_OPENING_TASK_OPTION_ID}" option must set freeText: true so the user can describe their task`,
      path: ["options"],
    });
  }
});

function resolveFirstTaskAssetUrl(relativePath: string) {
  return new URL(`../onboarding-assets/first-task/${relativePath}`, import.meta.url);
}

async function loadFirstTaskAsset(relativePath: string): Promise<string> {
  return fs.readFile(resolveFirstTaskAssetUrl(relativePath), "utf8");
}

// Fill the shared name/organization placeholders. When the agent has no name the
// greeting must read "I'm your first agent teammate" rather than leaving a gap,
// so we drop the placeholder together with its trailing separator — matching the
// historical buildOnboardingGreeting behaviour.
export function fillFirstTaskPlaceholders(
  text: string,
  { agentName, organizationName }: OnboardingFirstTaskPlaceholders,
): string {
  let out = text;
  const name = agentName?.trim();
  if (name) {
    out = out.split("{{agentName}}").join(name);
  } else {
    out = out
      .split("{{agentName}}, ").join("")
      .split("{{agentName}} ").join("")
      .split("{{agentName}}").join("");
  }
  const org = organizationName?.trim();
  out = out.split("{{organizationName}}").join(org && org.length > 0 ? org : "your organization");
  return out;
}

// Layer C — the deterministic greeting posted as the agent on the first task.
export async function renderOnboardingFirstTaskGreeting(
  placeholders: OnboardingFirstTaskPlaceholders,
): Promise<string> {
  const template = await loadFirstTaskAsset("greeting.md");
  return fillFirstTaskPlaceholders(template, placeholders).trim();
}

// Layer C — the opening ask_user_questions card seeded as the agent right after
// the greeting, so the first task is not open-ended: the user either asks to be
// interviewed or types the task they have in mind. Deterministic, no LLM.
export async function buildOnboardingFirstTaskOpeningQuestion(): Promise<AskUserQuestionsPayload> {
  const raw = await loadFirstTaskAsset("opening-question.json");
  const file = openingQuestionFileSchema.parse(JSON.parse(raw));
  return askUserQuestionsPayloadSchema.parse({
    version: 1,
    submitLabel: file.submitLabel ?? null,
    // A typed message instead of an answer still counts as the user's choice:
    // the card expires and the comment wakes the agent through the normal path.
    supersedeOnUserComment: true,
    questions: [
      {
        id: ONBOARDING_FIRST_TASK_OPENING_QUESTION_ID,
        prompt: file.prompt,
        helpText: file.helpText ?? null,
        selectionMode: "single",
        required: true,
        options: file.options,
      },
    ],
  });
}

// Layer A — the first task's description. brief.md carries {{proposalStep}},
// which is replaced by the proposal file the toggle selects.
export async function buildOnboardingFirstTaskBrief(options: {
  usePlanProposal: boolean;
}): Promise<string> {
  const [brief, proposal] = await Promise.all([
    loadFirstTaskAsset("brief.md"),
    loadFirstTaskAsset(options.usePlanProposal ? "proposal-plan.md" : "proposal-confirmation.md"),
  ]);
  const proposalStep = proposal.replace(/\s+$/, "");
  // Use a function replacement so `$` sequences in the proposal text are not
  // interpreted as replacement patterns.
  return brief.replace("{{proposalStep}}", () => proposalStep).trim();
}

// Layer B — the chief-of-staff persona seeded over the first agent's entry
// instruction file at hire time.
export async function renderChiefOfStaffPersona(
  placeholders: OnboardingFirstTaskPlaceholders,
): Promise<string> {
  const template = await loadFirstTaskAsset("chief-of-staff/AGENTS.md");
  return fillFirstTaskPlaceholders(template, placeholders);
}

// The instruction bundle for the onboarding first agent: the chief-of-staff
// persona as the entry AGENTS.md. The generic execution contract
// (default/AGENTS.md) is still appended on every run by the runner, unchanged.
export async function buildOnboardingFirstAgentInstructionsBundle(
  placeholders: OnboardingFirstTaskPlaceholders,
): Promise<{ files: Record<string, string>; entryFile: string }> {
  const persona = await renderChiefOfStaffPersona(placeholders);
  return { files: { "AGENTS.md": persona }, entryFile: "AGENTS.md" };
}
