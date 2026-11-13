import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/**
 * Durable Antigravity conversation state.
 *
 * A managed Antigravity run executes with its CLI home inside a fresh
 * temporary home (`prepareManagedAiRuntime`), and cleanup deletes that home
 * after every run. Only the credential is written back — so the CLI's
 * conversation files (`<cli-home>/brain/<conversationId>/`) were lost, and
 * the next heartbeat's `--conversation <id>` resume found nothing and fell
 * back to a fresh session, losing the prior context.
 *
 * These helpers keep the conversation state in a durable, account-scoped
 * location under the instance root, separate from the temporary credential
 * home: restore it into the fresh CLI home before the run, preserve it back
 * before the home is deleted. Only `brain/` moves — the OAuth token and
 * other CLI-home files keep their existing credential lifecycle and are
 * never copied here.
 *
 * The store is scoped per AGENT (company + grant + agent), not per grant:
 * a connection grant can be installed for many agents or company-wide, and
 * the restored `brain/` lands inside the run home the agent's own process
 * can read — and write. A grant-scoped store would hand every agent on the
 * grant every other agent's transcripts, and let one agent's writes poison
 * another agent's conversation on copy-back. Each agent restores and
 * preserves only its own directory, so a shared grant never leaks
 * conversations across agents. (Scoping further to a single session is not
 * possible here: the runtime never sees the run's conversation id — that
 * lives in the adapter's session params — so the agent boundary is the
 * ownership boundary this layer can enforce.)
 */

const AGY_CONVERSATION_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Durable directory holding one agent's Antigravity conversation state for
 * one connection grant (`brain/<conversationId>/...`). Null when any id
 * cannot be used as a path segment — fail closed rather than building a
 * path from an untrusted value.
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

async function hasEntries(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

/**
 * Copy a previous run's conversation state from the durable directory into
 * the fresh CLI home. Best-effort: a first run has nothing to restore, and
 * a failed restore must not block the run — resume simply falls back to a
 * fresh session, as it did before this preservation existed.
 */
export async function restoreAgyConversationState(
  cliHome: string,
  durableDir: string | null,
): Promise<void> {
  if (!durableDir || !(await hasEntries(durableDir))) return;
  try {
    await cp(durableDir, path.join(cliHome, "brain"), {
      recursive: true,
      force: true,
    });
  } catch {
    // A partial or failed restore leaves the run usable; the CLI resumes
    // what it can find and otherwise starts fresh.
  }
}

/**
 * Copy the run's conversation state out of the CLI home into the durable
 * directory before the temporary home is deleted. Best-effort: a failed
 * preserve must not block cleanup — it only loses the resume, which is the
 * status quo this preservation improves on.
 */
export async function preserveAgyConversationState(
  cliHome: string,
  durableDir: string | null,
): Promise<void> {
  if (!durableDir) return;
  const brainDir = path.join(cliHome, "brain");
  if (!(await hasEntries(brainDir))) return;
  try {
    await mkdir(durableDir, { recursive: true, mode: 0o700 });
    await cp(brainDir, durableDir, { recursive: true, force: true });
  } catch {
    // See restoreAgyConversationState: preservation is best-effort.
  }
}
