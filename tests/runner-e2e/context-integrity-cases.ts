import type { RunnerTaskFixture } from "./types.js";

export const CONTEXT_INTEGRITY_CASES = [
  "ordered-comment-continuation",
  "assigned-skill-explicit-invocation",
] as const;

export type ContextIntegrityCase = (typeof CONTEXT_INTEGRITY_CASES)[number];

export function contextIntegrityScenario(id: string, nonce: string) {
  if (!CONTEXT_INTEGRITY_CASES.includes(id as ContextIntegrityCase))
    throw new Error(`Unknown context-integrity case: ${id}`);
  const marker = `CONTEXT_OK_${nonce.replace(/[^a-z0-9]/gi, "")}`;
  const repeated = "Append an entry for every request, even identical wording.";
  const changed = "Change the final scope to the launch checklist and preserve every earlier entry.";
  return {
    id: id as ContextIntegrityCase,
    marker,
    repeated,
    changed,
    skillKey: `context-integrity-output-${nonce.replace(/[^a-z0-9]/gi, "")}`,
    skillName: "Context integrity output skill",
    prompt:
      id === "ordered-comment-continuation"
        ? `Maintain a packing list report document. Start with the initial scope: passport and charger. Save the initial report and leave this task waiting for follow-up comments. When follow-up comments arrive, copy each user's exact wording verbatim into one ordered ledger, including identical wording repeated more than once. After the follow-up batch, save one report containing both initial items and every verbatim request in arrival order. Add a separate section headed "## Final scope" outside the quoted ledger. Put only the final requested scope name as plain text in that section. Then finish. Do not invent extra comments, child tasks, or deliverables.`
        : "Use the assigned Context integrity output skill for this task, then follow its instructions and finish the task. Do not create child tasks or unrelated deliverables.",
    comments: [repeated, repeated, changed] as const,
  };
}

export const contextIntegrityTasks: readonly RunnerTaskFixture[] =
  CONTEXT_INTEGRITY_CASES.map((id) => ({
    id,
    label: id === "ordered-comment-continuation" ? "Ordered comment continuation" : "Assigned skill invocation",
    groups: ["context-integrity"],
    workMode: "standard",
    flow: "context_integrity",
    expectedRunCount: id === "ordered-comment-continuation" ? 2 : 1,
    attemptTimeoutMs: { local: 12 * 60_000, daytona: 12 * 60_000 },
    expectedTerminalState: { issue: "done", run: "succeeded" },
    buildTitle: (nonce) => `Context integrity ${id} ${nonce}`,
    buildPrompt: (nonce) => contextIntegrityScenario(id, nonce).prompt,
    buildVisibleMarker: (nonce) => contextIntegrityScenario(id, nonce).marker,
    buildMatchers: () => [],
  }));
