import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { chatEndpoints, chatVoiceSessions, chatVoiceToolCalls, toolConnections, type Db } from "@paperclipai/db";

export const LIVE_VOICE_EXECUTION_GUIDANCE = [
  "## Live voice request",
  "You are actively talking with a caller through Speko. Get a useful spoken response to them as quickly as possible. Immediately publish a brief, caller-safe task comment explaining what you are doing, using the Paperclip task-comment tooling so it can reach the live call. Then find the answer and publish the concise result on this same task. The initial update is not a final answer: continue working after posting it. Start the smallest necessary action immediately; avoid routine planning, redundant preflight checks, and a long introduction. Lead with a short answer or outcome in your normal task reply so it can be spoken while the call is live.",
  "Speko handles quick acknowledgments and conversational pacing while you do the work. Acceptance of submit_request is not completion. Inspect your real execution environment when asked about your computer, files, disk space, or capabilities. Never invent a result to reduce latency.",
  "For longer work, publish a brief caller-safe progress update, then continue working. For commands expected to finish within a minute or two, request a blocking execution with a sufficient timeout and background execution disabled. Do not choose an asynchronous Monitor to wait for a required result in an ephemeral sandbox. If a tool returns a background job or asynchronous monitor, wait for its final output using the runtime’s blocking result tool, or explicitly arrange a durable Paperclip continuation. A progress reply or a promise to check later is not a continuation; do not end your turn while unfinished work exists only in that sandbox. Accept follow-up instructions on this same task. Hanging up or interrupting playback does not cancel work. Keep detailed output on the task and preserve all ordinary permissions, containment, budgets, and approval requirements.",
].join("\n\n");

/** Derive live context from accepted server records, never from caller text or wake metadata. */
export async function liveVoiceExecutionGuidance(db: Db, input: {
  companyId: string; issueId: string; agentId: string;
}, now = new Date()): Promise<string | null> {
  const [live] = await db.select({ id: chatVoiceSessions.id, authority: chatVoiceSessions.callerAuthority }).from(chatVoiceSessions)
    .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatVoiceSessions.endpointId), eq(chatEndpoints.companyId, chatVoiceSessions.companyId)))
    .innerJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId), eq(toolConnections.companyId, chatEndpoints.companyId)))
    .where(and(
      eq(chatVoiceSessions.companyId, input.companyId), eq(chatVoiceSessions.issueId, input.issueId),
      eq(chatVoiceSessions.assignedAgentId, input.agentId), eq(chatEndpoints.assignedAgentId, input.agentId),
      eq(chatEndpoints.provider, "speko"), inArray(chatEndpoints.status, ["active", "verifying"]),
      eq(toolConnections.status, "active"), eq(toolConnections.enabled, true),
      eq(chatVoiceSessions.state, "active"), isNull(chatVoiceSessions.endedAt), gt(chatVoiceSessions.expiresAt, now),
      inArray(chatVoiceSessions.callerAuthority, ["member", "instance_admin", "local_board", "guest_intake"]),
      sql`${chatVoiceSessions.generation} = coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::integer, 0)`,
      sql`exists (select 1 from ${chatVoiceToolCalls} where ${chatVoiceToolCalls.companyId} = ${chatVoiceSessions.companyId}
        and ${chatVoiceToolCalls.sessionId} = ${chatVoiceSessions.id} and ${chatVoiceToolCalls.tool} = 'submit_request'
        and ${chatVoiceToolCalls.deliveryId} is not null)`,
    )).limit(1);
  return live ? [LIVE_VOICE_EXECUTION_GUIDANCE, live.authority === "guest_intake"
    ? "This caller is unverified. Ask any clarification as a brief task comment and continue when submit_request brings their spoken follow-up. Do not use ask_user_questions or create a protected human-input wait. Guest answers cannot grant approval or access to private work."
    : null].filter(Boolean).join("\n\n") : null;
}
