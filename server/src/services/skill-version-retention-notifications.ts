import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export function notifySkillVersionRetention(tx: object, companyId: string) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.skillVersionRetention, companyId);
}

export function notifySkillVersionRetentionReconstruction(tx: object) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.skillVersionRetention, "*");
}

type CacheChange = { root: string; companyId: string; directory: string; occurredAt: number; source: "access" | "publication" };
const listeners = new Set<(change: CacheChange) => void>();
export function onSkillVersionCacheChange(listener: (change: CacheChange) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function noteSkillVersionCacheChange(directory: string, change: { occurredAt?: number; source?: "access" | "publication" } = {}) {
  const root = path.resolve(resolvePaperclipInstanceRoot(), "skills");
  const [companyId, versions] = path.relative(root, directory).split(path.sep);
  if (versions !== "__versions__" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(companyId)) return;
  const suppliedAt = change.occurredAt ?? Date.now();
  const occurredAt = Number.isSafeInteger(suppliedAt) && suppliedAt > 0 ? suppliedAt : Date.now();
  for (const listener of listeners) listener({ root, companyId, directory: path.resolve(directory), occurredAt, source: change.source ?? "publication" });
}

export async function notifySkillVersionPinChange(tx: object, companyId: string, before: Record<string, unknown>, after: Record<string, unknown>) {
  if (JSON.stringify(readPaperclipSkillSyncPreference(before).desiredSkillEntries)
    !== JSON.stringify(readPaperclipSkillSyncPreference(after).desiredSkillEntries)) {
    await notifySkillVersionRetention(tx, companyId);
  }
}
