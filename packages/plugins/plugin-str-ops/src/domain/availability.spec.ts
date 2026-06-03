import { describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memory-store.js";
import { isPropertyAvailable, nightsBetween } from "./availability.js";

const CO = "company-1";

async function seedBooking(store: MemoryStore, checkIn: string, checkOut: string) {
  await store.insertBooking({
    companyId: CO, propertyId: "p1", guestId: "g1", channel: "airbnb", status: "confirmed",
    checkIn, checkOut, nights: nightsBetween(checkIn, checkOut), grossCents: 1, feesCents: 0, externalRef: `r-${checkIn}`,
  });
}

describe("availability", () => {
  it("computes nights between two ISO dates", () => {
    expect(nightsBetween("2026-07-01", "2026-07-05")).toBe(4);
  });

  it("is available when no overlapping booking exists", async () => {
    const store = new MemoryStore();
    await seedBooking(store, "2026-07-01", "2026-07-05");
    expect(await isPropertyAvailable(store, CO, "p1", "2026-07-05", "2026-07-08")).toBe(true); // adjacent, no overlap
  });

  it("is unavailable when dates overlap an existing non-cancelled booking", async () => {
    const store = new MemoryStore();
    await seedBooking(store, "2026-07-01", "2026-07-05");
    expect(await isPropertyAvailable(store, CO, "p1", "2026-07-04", "2026-07-06")).toBe(false);
  });
});
