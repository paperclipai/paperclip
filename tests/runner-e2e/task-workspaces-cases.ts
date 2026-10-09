import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerProfileFixture, RunnerTaskFixture } from "./types.js";

export const TASK_WORKSPACES_SUITE = "task-workspaces";
export const TASK_WORKSPACES_BUDGET_CENTS = 1_000;
export const TASK_REPOSITORY_URL = "https://github.com/octocat/Hello-World";
export function taskWorkspaceFiles(nonce: string) {
  return { note: `task-note-${nonce}.txt`, proof: `task-proof-${nonce}.txt`, repositoryFile: `repository-proof-${nonce}.txt`,
    noteBytes: (turn: number) => `task-files-turn-${turn}-${nonce}\n`, repositoryBytes: `repository-dirty-${nonce}\n` };
}

/** Remove the legacy operator cwd so this suite actually exercises default admission. */
export function taskWorkspaceProfile(profile: RunnerProfileFixture): RunnerProfileFixture {
  return { ...profile, buildAgent(input) {
    const agent = profile.buildAgent(input);
    const { cwd: _cwd, ...adapterConfig } = agent.adapterConfig as Record<string, unknown>;
    return { ...agent, adapterConfig, budgetMonthlyCents: TASK_WORKSPACES_BUDGET_CENTS };
  } };
}

export function taskWorkspacePrompt(nonce: string, turn: 1 | 2 | 3, native: boolean) {
  const files = taskWorkspaceFiles(nonce);
  const inspect = native ? "Use get_workspace to inspect your admitted task workspace."
    : "GET /api/issues/$PAPERCLIP_TASK_ID/workspace through the authenticated public API to inspect your task workspace.";
  const api = native ? "Use the real Paperclip semantic tools."
    : 'Use the injected PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_RUN_ID for the public API. Normalize API_ORIGIN="${PAPERCLIP_API_URL%/}"; API_ORIGIN="${API_ORIGIN%/api}". Include Authorization: Bearer and X-Paperclip-Run-Id on API requests. Never print credentials.';
  const content = turn === 1 ? [
    "This is the first of three separately requested steps. Do only this step now; a later user message will request the next step.",
    inspect,
    `In the current task directory write ${files.note} with exactly ${JSON.stringify(files.noteBytes(1))}. Keep task files outside AGENT_HOME.`,
    "Stage a repository for the NEXT normal admission; do not clone it yourself, create a project, switch roots, wait for a new run, or wake this task.",
    native ? `Call prepare_repository twice with exactly {repository:{kind:"url",url:"${TASK_REPOSITORY_URL}"},requestKey:"repository-${nonce}"}. Both calls must report the same preparation receipt and next_normal_admission.`
      : `POST /api/issues/$PAPERCLIP_TASK_ID/workspace/repositories twice with the same JSON {"repository":{"kind":"url","url":"${TASK_REPOSITORY_URL}"},"requestKey":"repository-${nonce}"}. Both replies must return the same operationId and next_normal_admission.`,
    "Inspect the workspace again. Its identity/root must be unchanged and the repository should still be pending. The repository need not exist yet. The objective of this step is staged preparation, not a completed clone.",
  ] : turn === 2 ? [
    "Continue this same task after the controller restart. Do only step two now.", inspect,
    `Read ${files.note} and require its exact bytes to be ${JSON.stringify(files.noteBytes(1))}; fail visibly if missing or different.`,
    "The previously staged repository must now be ready in the reported contained relativePath. Do not prepare or clone a replacement, create a project, or switch the task root.",
    `Inside that checkout create ${files.repositoryFile} containing exactly ${JSON.stringify(`repository-committed-${nonce}\n`)}. Commit ONLY that file using git -c user.name='Workspace Fixture' -c user.email='fixture@example.test' commit with message workspace-proof-${nonce}. Do not push.`,
    `Then overwrite that committed file with exactly ${JSON.stringify(files.repositoryBytes)}, leaving this local change uncommitted.`,
    `Update the task-root ${files.note} to exactly ${JSON.stringify(files.noteBytes(2))}.`,
  ] : [
    "Continue this same task with the final step. Do not recreate a missing repository or missing earlier files.", inspect,
    `Read ${files.note}; require exactly ${JSON.stringify(files.noteBytes(2))}.`,
    `Read the existing ${files.repositoryFile} in the prepared checkout. Copy its bytes unchanged to ${files.proof} in the task root. Do not edit or commit the repository in this step.`,
    `Update ${files.note} to exactly ${JSON.stringify(files.noteBytes(3))}.`,
    `Register ${files.proof} as a downloadable artifact work product with exact title ${files.proof}.`,
  ];
  return [...content, "The quoted \\n escapes denote actual LF bytes. Include the final LF when writing each exact string; verify byte counts before finishing.", api,
    turn < 3 ? "Save a short Paperclip task document describing this completed step as its durable work product. Then complete this step and mark the task Done; do not wait for the next user message."
      : "Validate the written and downloaded-proof source bytes before completing the task.",
    native ? "Use paperclip_finish with reportedWorkDisposition done, the current completion contract revision, satisfied objective criterion, real evidence references, and no remaining work for THIS requested step."
      : "Complete through the normal public task API after saving the work product.",
    `Use TASK-WORKSPACE-${turn}-${nonce} as the completion summary and final response. Do not do unrelated work.`,
  ].join("\n");
}

export const taskWorkspaceTask: RunnerTaskFixture = {
  id: "task-directory-repository-resume", label: "Task files, repository preparation and restart", groups: [],
  flow: "task_workspaces", workMode: "standard", expectedRunCount: 3, automaticRetryPolicy: "single_attempt",
  attemptTimeoutMs: { local: 15 * 60_000, daytona: 15 * 60_000 }, turnTimeoutMs: 4 * 60_000,
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Task files without a project ${nonce}`,
  buildVisibleMarker: nonce => `TASK-WORKSPACE-3-${nonce}`,
  buildPrompt: nonce => taskWorkspacePrompt(nonce, 1, true), buildMatchers: () => [],
};
export function taskWorkspaceDefinitionDigest() {
  const hash = createHash("sha256");
  for (const file of ["task-workspaces-cases.ts", "task-workspaces-flow.ts", "task-workspaces-scoring.ts", "registered-artifact.ts", "live-fixtures.ts", "runner.spec.ts"]) {
    hash.update(file).update(readFileSync(new URL(file, import.meta.url)));
  }
  return hash.digest("hex");
}
