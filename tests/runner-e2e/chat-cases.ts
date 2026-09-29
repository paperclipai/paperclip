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
  ["create-backlog", "Save a planned task without starting work", 2],
  ["reassign-task", "Reassign existing work and preserve queued context", 2],
  ["continuity-restart", "Conversation continuity across restart", 3],
  ["new-session", "Fresh context within preserved history", 2],
  ["stop-new-resume", "Stop, reset, and resume", 3],
  ["plan-handoff", "Draft, revise, approve, and hand off a plan", 4],
  ["clarify-reuse", "Clarify and reuse an existing project", 3],
  ["multi-repository", "Create a project with multiple repository URLs", 2],
] as const;
export type ChatCase = (typeof CHAT_CASES)[number][0];
const HARDENING_CASES = [
  ["stop-startup-new-resume", "Stop during startup, reset, and resume", 3],
  ["hire-delegate-reuse", "Hire through chat, delegate, and reuse the same teammate", 5],
  ["blocked-status-review", "Read the actual blocker and hand source material to a reviewer", 4],
  ["committed-send-retry", "Recover a lost send acknowledgement without repeating committed work", 2],
  ...CHAT_CASES.filter(([id]) => ["stop-new-resume", "continuity-restart"].includes(id)),
] as const;
function buildChatTasks(definitions: readonly (readonly [string, string, number])[]): readonly RunnerTaskFixture[] {
  return definitions.map(
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
}
export const chatTasks = buildChatTasks(CHAT_CASES);
export const chatHardeningTasks = buildChatTasks(HARDENING_CASES);
export const chatStoryTasks = buildChatTasks([
  ["enable-disable-resume", "Enable Agent Chat, pause access, and resume preserved history", 2],
  ["followup-while-running", "Deliver a follow-up while a provider turn is running", 2],
  ["revise-while-running", "Change instructions during active work and save the updated plan", 2],
]).map(task => ({ ...task, ...(task.id === "enable-disable-resume" ? {} : { minimumExpectedRunCount: 1 }) }));

export function chatNeedsApiTools(suiteId: string, caseId: string): boolean {
  return (suiteId === "agent-chat-qualification" && caseId === "grounded-answer-quality") || suiteId === "agent-chat-hardening" && ["hire-delegate-reuse", "blocked-status-review"].includes(caseId);
}
export function isManagedHiringCase(suiteId: string, caseId: string): boolean {
  return (suiteId === "everyday-workflows" && caseId === "hire-reuse") ||
    (suiteId === "agent-chat-hardening" && caseId === "hire-delegate-reuse");
}

export const chatQualificationTasks = buildChatTasks([
  ["active-reassignment", "Reassign an executing task and preserve its saved work", 3],
  ["worker-crash-retry", "Recover from worker process loss through visible Retry", 2],
  ["grounded-answer-quality", "Ground status, correct stale claims, and acknowledge uncertainty", 2],
]);

export const chatCompletionTasks = buildChatTasks([
  ["handoff-completion-idle", "Report a delegated result after the chat goes idle", 4],
]).map(task => ({ ...task, minimumExpectedRunCount: 2 }));
