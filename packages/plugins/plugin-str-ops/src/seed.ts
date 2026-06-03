import { randomUUID } from "node:crypto";
import type { Owner, Property } from "./domain/types.js";
import type { StrOpsStore } from "./store/types.js";

export async function seedDemo(store: StrOpsStore, companyId: string): Promise<{ owners: number; properties: number }> {
  const owner: Owner = { id: randomUUID(), companyId, name: "Deborah Owner", email: "owner@example.com", commissionPct: 20 };
  await store.insertOwner(owner);
  const properties: Property[] = [
    { id: randomUUID(), companyId, name: "Villa Sud", externalCode: "VILLA-SUD", ownerId: owner.id, basePriceCents: 20000, currency: "EUR" },
    { id: randomUUID(), companyId, name: "Studio Port", externalCode: "STUDIO-PORT", ownerId: owner.id, basePriceCents: 12000, currency: "EUR" },
  ];
  for (const p of properties) await store.insertProperty(p);
  return { owners: 1, properties: properties.length };
}
