import { describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memory-store.js";
import { MockChannelProvider } from "../providers/mock-channel.js";
import type { RawBooking } from "./types.js";
import { ingestNewBookings } from "./ingest.js";

const CO = "company-1";

async function storeWithProperty(externalCode: string) {
  const store = new MemoryStore();
  await store.insertOwner({ id: "o1", companyId: CO, name: "Owner", email: "o@x.com", commissionPct: 20 });
  await store.insertProperty({
    id: "p1", companyId: CO, name: "Villa", externalCode, ownerId: "o1", basePriceCents: 20000, currency: "EUR",
  });
  return store;
}

const raw = (over: Partial<RawBooking> = {}): RawBooking => ({
  externalRef: "AB-1", channel: "airbnb", propertyExternalCode: "VILLA-SUD",
  guest: { name: "Ana", contact: "ana@x.com", locale: "en" },
  checkIn: "2026-07-10", checkOut: "2026-07-14", grossCents: 80000, feesCents: 8000, ...over,
});

describe("ingestNewBookings", () => {
  it("creates a booking + guest for a new raw booking on a known property", async () => {
    const store = await storeWithProperty("VILLA-SUD");
    const result = await ingestNewBookings({ companyId: CO, store, channelProvider: new MockChannelProvider([raw()]) });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.nights).toBe(4);
    expect(result.created[0]!.status).toBe("confirmed");
    expect(await store.listBookings(CO)).toHaveLength(1);
  });

  it("skips a duplicate externalRef on the same channel", async () => {
    const store = await storeWithProperty("VILLA-SUD");
    const deps = { companyId: CO, store, channelProvider: new MockChannelProvider([raw(), raw()]) };
    const result = await ingestNewBookings(deps);
    expect(result.created).toHaveLength(1);
    expect(result.skippedDuplicate).toBe(1);
  });

  it("skips a raw booking whose property code is unknown", async () => {
    const store = await storeWithProperty("VILLA-SUD");
    const result = await ingestNewBookings({ companyId: CO, store, channelProvider: new MockChannelProvider([raw({ propertyExternalCode: "NOPE" })]) });
    expect(result.created).toHaveLength(0);
    expect(result.skippedUnknownProperty).toBe(1);
  });

  it("skips a raw booking that overlaps an existing booking and flags a conflict", async () => {
    const store = await storeWithProperty("VILLA-SUD");
    await ingestNewBookings({ companyId: CO, store, channelProvider: new MockChannelProvider([raw()]) });
    const result = await ingestNewBookings({
      companyId: CO, store,
      channelProvider: new MockChannelProvider([raw({ externalRef: "AB-2", checkIn: "2026-07-12", checkOut: "2026-07-16" })]),
    });
    expect(result.created).toHaveLength(0);
    expect(result.skippedConflict).toBe(1);
  });
});
