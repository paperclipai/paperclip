import type { RunnerTaskFixture } from "./types.js";

// Markers cross the rich-text composer and Markdown persistence boundary.
// Alphanumeric text has identical visible and stored representations.
export function chatMarker(
  prefix: "CHAT" | "DRAFT" | "OLDCONTEXT",
  nonce: string,
) {
  return `${prefix}${nonce.replace(/[^a-zA-Z0-9]/g, "")}`;
}

export const CHAT_CASES = [
  ["continuity-restart", "Conversation continuity across restart", 3],
  ["new-session", "Fresh context within preserved history", 2],
  ["stop-new-resume", "Stop, reset, and resume", 3],
  ["plan-handoff", "Draft, revise, approve, and hand off a plan", 4],
  ["clarify-reuse", "Clarify and reuse an existing project", 3],
  ["multi-repository", "Create a project with multiple repository URLs", 2],
] as const;
export type ChatCase = (typeof CHAT_CASES)[number][0];
export const chatTasks: readonly RunnerTaskFixture[] = CHAT_CASES.map(
  ([id, label, expectedRunCount]) => ({
    id,
    label,
    groups: ["chat"],
    flow: "agent_chat",
    workMode: "standard",
    expectedRunCount, // Provider turns, including cancelled turns and handed-off work; reset runs are separate.
    attemptTimeoutMs: { local: 15 * 60_000, daytona: 15 * 60_000 },
    expectedTerminalState: { issue: "in_review", run: "succeeded" },
    buildTitle: (nonce) => `Chat acceptance ${id} ${nonce}`,
    buildPrompt: (nonce) => `Let's discuss ${nonce}.`,
    buildVisibleMarker: (nonce) => chatMarker("CHAT", nonce),
    buildMatchers: () => [{ kind: "issue_status", expected: "in_review" }],
  }),
);
