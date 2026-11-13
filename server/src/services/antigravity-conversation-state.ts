import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/**
 * Durable Antigravity conversation state: the account-scoped directory
 * holding one agent's conversation state for one connection grant.
 *
 * A managed Antigravity run executes with its CLI home inside a fresh
 * temporary home (`prepareManagedAiRuntime`), and cleanup deletes that home
 * after every run. Only the credential is written back — so the CLI's
 * conversation files were lost, and the next heartbeat's resume found
 * nothing and fell back to a fresh session, losing the prior context.
 *
 * The durable directory is computed here — company isolation is a server
 * invariant — and the copy steps live in the adapter
 * (`@paperclipai/adapter-agy-local/server`: `restoreAgyConversationState`,
 * `preserveAgyConversationState`), which owns the CLI home layout.
 *
 * The store is scoped per AGENT (company + grant + agent), not per grant:
 * a connection grant can be installed for many agents or company-wide, and
 * the restored conversation files land inside the run home the agent's own
 * process can read — and write. A grant-scoped store would hand every agent
 * on the grant every other agent's transcripts, and let one agent's writes
 * poison another agent's conversation on copy-back. Each agent restores and
 * preserves only its own directory, so a shared grant never leaks
 * conversations across agents. (Scoping further to a single session is not
 * possible here: the runtime never sees the run's conversation id — that
 * lives in the adapter's session params — so the agent boundary is the
 * ownership boundary this layer can enforce.)
 */

const AGY_CONVERSATION_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Durable directory holding one agent's Antigravity conversation state for
 * one connection grant. Null when any id cannot be used as a path segment —
 * fail closed rather than building a path from an untrusted value.
 */
export function resolveAgyConversationDir(
  companyId: string,
  grantId: string,
  agentId: string,
): string | null {
  if (
    !AGY_CONVERSATION_SEGMENT_RE.test(companyId) ||
    !AGY_CONVERSATION_SEGMENT_RE.test(grantId) ||
    !AGY_CONVERSATION_SEGMENT_RE.test(agentId)
  ) {
    return null;
  }
  return path.join(
    resolvePaperclipInstanceRoot(),
    "ai-connections",
    companyId,
    grantId,
    "agents",
    agentId,
    "antigravity-brain",
  );
}
