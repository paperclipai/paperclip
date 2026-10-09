import type { RunnerTaskFixture } from "./types.js";

export const FIRST_TASK_CASES = [
  ["interview-first-response", "Interview: first response", "interview", 1],
  ["clear-task-first-response", "Clear task: first response", "task", 1],
  [
    "ambiguous-task-first-response",
    "Ambiguous task: first response",
    "ambiguous",
    1,
  ],
  [
    "plain-message-first-response",
    "Opening card replaced by a message",
    "message",
    1,
  ],
  ["plan-first-response", "Explicit plan: first response", "plan", 1],
  [
    "ordinary-task-control",
    "Other tasks do not inherit onboarding policy",
    "ordinary",
    1,
  ],
  ["interview-plan-accept", "Interview, plan, and acceptance", "interview", 3],
  ["task-card-accept", "Subtask accepted through a card", "task", 3],
  ["accept-while-running", "Accept a proposal while its agent is still running", "task", 3],
  ["task-reply-accept", "Subtask accepted in conversation", "task", 3],
  [
    "clarify-propose-accept",
    "Clarification, proposal, and acceptance",
    "ambiguous",
    4,
  ],
  ["revise-accept", "Revise scope before accepting", "task", 4],
  ["reject-no-execution", "Decline proposed work", "task", 2],
] as const;
export type FirstTaskCaseId = (typeof FIRST_TASK_CASES)[number][0];
export type FirstTaskOpening = (typeof FIRST_TASK_CASES)[number][2];
export const firstTaskMarker = (nonce: string) =>
  `GARDEN${nonce.replace(/[^a-z0-9]/gi, "")}`;
export function firstTaskScenario(id: string, nonce: string) {
  const entry = FIRST_TASK_CASES.find((row) => row[0] === id);
  if (!entry) throw new Error(`Unknown first-task case ${id}`);
  const marker = firstTaskMarker(nonce);
  const originalMarker = id === "revise-accept" ? `DRAFT${marker}` : marker;
  const task = `I need a two-sentence welcome note for our neighborhood garden club. It should invite beginners to our free Saturday meetup and include the phrase ${originalMarker}. Save the finished note as a document attached to the task.`;
  const facts = `We run a neighborhood garden club for beginners. Our first goal is a two-sentence welcome note inviting people to our free Saturday meetup. We have no budget and need no outside tools. Done means the note is saved as a task document and includes ${marker}.`;
  return {
    id: entry[0],
    opening: entry[2],
    marker,
    originalMarker,
    facts,
    firstResponseOnly:
      id.endsWith("first-response") || id === "ordinary-task-control",
    prompt:
      entry[2] === "ambiguous"
        ? "Help me get my organization going."
        : entry[2] === "plan"
          ? `Write a short plan for welcoming new members to our garden club. ${facts} Let me review the plan before any work starts.`
          : entry[2] === "ordinary"
            ? `Write the welcome note now on this task; no interview or subtask is needed. ${task}`
            : task,
    revision: `Change the note: invite people to our Sunday meetup instead, and replace ${originalMarker} with ${marker}. Please revise your proposal; I have not accepted it yet.`,
    acceptance: "Yes, I accept that proposal. Please do it.",
    rejection:
      "No, do not proceed. I do not want this work done. Please acknowledge that and stop.",
  };
}
export const firstTaskTasks: readonly RunnerTaskFixture[] =
  FIRST_TASK_CASES.map(([id, label, , expectedRunCount]) => ({
    id,
    label,
    groups: ["onboarding"],
    flow: "first_task",
    workMode: "standard",
    expectedRunCount,
    attemptTimeoutMs: { local: 15 * 60_000, daytona: 15 * 60_000 },
    expectedTerminalState: { issue: "in_review", run: "succeeded" },
    buildTitle: (nonce) => `First task ${id} ${nonce}`,
    buildPrompt: (nonce) => firstTaskScenario(id, nonce).prompt,
    buildVisibleMarker: firstTaskMarker,
    buildMatchers: () => [], // Checkpoints and state effects are graded by first-task-scoring.
  }));
