import { createHash } from "node:crypto";
/** Ordering is local to a negotiated delivery namespace, never the run lifetime. */
export const COMMAND_EPOCH_CAPABILITY = "transport.command_epochs.v1";
export const COMMAND_EPOCH_LIMIT = 1_048_576;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface CommandEpochTransition {
  schema: "paperclip.prp.command-epoch.v1";
  runId: string;
  transitionId: string;
  fromEpoch: string | null;
  nextEpoch: string;
  finalOrdinal: number;
}
export function isCommandEpoch(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}
export function isCommandEpochTransition(value: unknown): value is CommandEpochTransition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as CommandEpochTransition;
  return Object.keys(v).length === 6 && v.schema === "paperclip.prp.command-epoch.v1"
    && typeof v.runId === "string" && v.runId.length > 0 && v.runId.length <= 240
    && isCommandEpoch(v.transitionId) && (v.fromEpoch === null || isCommandEpoch(v.fromEpoch))
    && isCommandEpoch(v.nextEpoch) && v.nextEpoch !== v.fromEpoch
    && Number.isSafeInteger(v.finalOrdinal) && v.finalOrdinal > 0;
}
/** Current proof slots from older epochs precede this epoch's ordered suffix.
 * There is at most one old settled receipt per slot; no history traversal. */
export function compareCurrentCommands(
  a: { controllerEpoch?: string; controllerSeq: number },
  b: { controllerEpoch?: string; controllerSeq: number },
  epoch: string | undefined,
): number {
  if (a.controllerEpoch === b.controllerEpoch) return a.controllerSeq - b.controllerSeq;
  return Number(a.controllerEpoch === epoch) - Number(b.controllerEpoch === epoch);
}


export function commandEpochCloseId(transition: Pick<CommandEpochTransition, "runId" | "fromEpoch">): string {
  return `command-epoch-from-${createHash("sha256").update(JSON.stringify([transition.runId, transition.fromEpoch])).digest("hex")}`;
}
