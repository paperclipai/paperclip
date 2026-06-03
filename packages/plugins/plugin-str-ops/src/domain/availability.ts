import type { StrOpsStore } from "../store/types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  return Math.round((b - a) / MS_PER_DAY);
}

export async function isPropertyAvailable(
  store: StrOpsStore,
  companyId: string,
  propertyId: string,
  checkIn: string,
  checkOut: string,
): Promise<boolean> {
  const overlaps = await store.findOverlappingBookings(companyId, propertyId, checkIn, checkOut);
  return overlaps.length === 0;
}
