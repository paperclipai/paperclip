import { companySkillVersions, type Db } from "@paperclipai/db";
import { and, eq, getTableColumns, sql } from "drizzle-orm";

type Version = typeof companySkillVersions.$inferSelect;
type Verification = { inventorySha256: string; expectedInventoryHash: string };
const verifiedInventories = new WeakMap<Db, Map<string, Verification>>();
const inventorySha256 = sql<string>`encode(sha256(convert_to(${companySkillVersions.fileInventory}::text, 'UTF8')), 'hex')`;

export async function verifyExistingBundledSkillRelease(input: {
  db: Db;
  companyId: string;
  skillId: string;
  releaseId: string;
  expectedInventoryHash: string;
  validateInventory: (version: Version) => void | Promise<void>;
}): Promise<boolean> {
  const scope = and(eq(companySkillVersions.companyId, input.companyId),
    eq(companySkillVersions.companySkillId, input.skillId), eq(companySkillVersions.releaseId, input.releaseId));
  const [current] = await input.db.select({ id: companySkillVersions.id, inventorySha256 })
    .from(companySkillVersions).where(scope).limit(1);
  if (!current) return false;
  let verified = verifiedInventories.get(input.db);
  if (!verified) {
    verified = new Map();
    verifiedInventories.set(input.db, verified);
  }
  const previous = verified.get(current.id);
  if (previous?.inventorySha256 === current.inventorySha256
    && previous.expectedInventoryHash === input.expectedInventoryHash) {
    verified.delete(current.id);
    verified.set(current.id, previous);
    return true;
  }
  const [version] = await input.db.select({ ...getTableColumns(companySkillVersions), inventorySha256 })
    .from(companySkillVersions).where(scope).limit(1);
  if (!version) return false;
  await input.validateInventory(version);
  verified.delete(version.id);
  verified.set(version.id, { inventorySha256: version.inventorySha256, expectedInventoryHash: input.expectedInventoryHash });
  while (verified.size > 64) {
    const oldest = verified.keys().next().value;
    if (oldest !== undefined) verified.delete(oldest);
  }
  return true;
}
