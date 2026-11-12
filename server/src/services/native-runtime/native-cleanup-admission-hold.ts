import type { Db } from "@paperclipai/db";
import { nativeSessionCleanupBlock } from "../../vendor/paperclip-runner/index.js";

/**
 * A task's previous native session can still be closing in this process when
 * its next run is admitted, for example right after a reassignment stopped
 * the previous assignee's run mid-turn. The runner refuses every new session
 * of the task until that close settles, and when the close cannot prove that
 * the old runner suspended it never settles by itself. A run dispatched into
 * that gate fails with `native_session_cleanup_quarantined` before it launches,
 * and only a Retry continued the task.
 *
 * Queue admission asks here first. A close that is still settling keeps the
 * run queued; its release wakes queued-run dispatch. A close that needs proof
 * is retired once the old owner's runner and provider processes are proven
 * stopped (the same proof Retry uses); until then the run stays queued. The
 * hold grants no execution authority: dispatch repeats every other check.
 */
export async function nativeCleanupHoldsAdmission(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<"pending" | "operator_required" | null> {
  let block = nativeSessionCleanupBlock(input);
  if (block === "operator_required") {
    const { retireStoppedSessionCleanupGates } = await import("./native-session-executor.js");
    await retireStoppedSessionCleanupGates(db, input).catch(() => false);
    block = nativeSessionCleanupBlock(input);
  }
  return block;
}
