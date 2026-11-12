import type { Db } from "@paperclipai/db";
import { nativeSessionCleanupBlock } from "../../vendor/paperclip-runner/index.js";

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
