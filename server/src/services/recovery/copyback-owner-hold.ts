import type { Db } from "@paperclipai/db";
import { copybackOwnerStamp } from "../native-runtime/native-workspace-owner-stop-proof.js";
import type { OwnerProof } from "../owner-proof.js";
import type { InProgressRecord, RecordOwner, SettleOutcome } from "./ownership-registry.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" && value ? value : null;

export function copybackOwnerHoldOwner(evidence: unknown): RecordOwner {
  const owner = object(object(object(evidence).workspaceOwnerRecovery).owner);
  const pid = typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0 ? owner.pid : null;
  const hostname = text(owner.hostname);
  const processStartedAt = text(owner.processStartedAt);
  if (!pid || !hostname || !processStartedAt) return { kind: "none" };
  const controllerBootId = text(owner.controllerBootId);
  const hostHash = text(owner.hostHash);
  return { kind: "process", stamp: { ...copybackOwnerStamp({ hostname, pid, processStartedAt,
    ...(controllerBootId ? { controllerBootId } : {}), ...(hostHash ? { hostHash } : {}) }), scope: "copyback_owner_hold" } };
}

export async function settleCopybackOwnerHold(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (record.owner.kind !== "process" || !record.companyId) return { settled: false, reason: "owner_not_provable" };
  const { wakeCopybackOwnerRecheck } = await import("../workspace-recovery.js");
  const stamp = record.owner.stamp;
  const woke = await wakeCopybackOwnerRecheck(db, { companyId: record.companyId, actionId: record.recordId,
    now: context.now, owner: { pid: stamp.pid, processStartedAt: stamp.processStartedAt, bootId: stamp.bootId,
      processSpace: stamp.processSpace } });
  return woke ? { settled: false, reason: "copyback_recheck_woken" }
    : { settled: false, reason: "copyback_recheck_not_waiting", watch: false };
}
