import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Antigravity CLI conversation state.
 *
 * The CLI keeps its conversation files under
 * `<cli-home>/brain/<conversationId>/`. This module owns that layout and
 * the steps for copying a run's conversation state between a CLI home and
 * a durable directory. The server decides when (restore before the run,
 * preserve at cleanup) and where (the durable, account-scoped directory
 * it computes and passes in as an opaque path); it never names the layout
 * itself. Only the conversation state moves — the OAuth token and other
 * CLI-home files keep their existing credential lifecycle and are never
 * copied here.
 */

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
