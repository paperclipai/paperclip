import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory-store.js";

const CO = "company-1";

describe("MemoryStore", () => {
  it("upserts a guest idempotently by (companyId, contact)", async () => {
    const store = new MemoryStore();
    const a = await store.upsertGuestByContact({ companyId: CO, name: "Ana", contact: "ana@x.com", locale: "en" });
    const b = await store.upsertGuestByContact({ companyId: CO, name: "Ana R.", contact: "ana@x.com", locale: "en" });
    expect(b.id).toBe(a.id);
    expect(b.name).toBe("Ana R."); // latest name wins
  });

  it("finds a booking by external ref scoped to channel + company", async () => {
    const store = new MemoryStore();
    const g = await store.upsertGuestByContact({ companyId: CO, name: "Ana", contact: "ana@x.com", locale: "en" });
    await store.insertBooking({
      companyId: CO, propertyId: "p1", guestId: g.id, channel: "airbnb", status: "confirmed",
      checkIn: "2026-07-01", checkOut: "2026-07-05", nights: 4, grossCents: 40000, feesCents: 4000, externalRef: "AB-1",
    });
    expect(await store.findBookingByExternalRef(CO, "airbnb", "AB-1")).not.toBeNull();
    expect(await store.findBookingByExternalRef(CO, "booking", "AB-1")).toBeNull();
    expect(await store.findBookingByExternalRef("other-co", "airbnb", "AB-1")).toBeNull();
  });
});
