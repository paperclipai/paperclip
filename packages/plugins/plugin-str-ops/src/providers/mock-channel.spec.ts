import { describe, expect, it } from "vitest";
import type { RawBooking } from "../domain/types.js";
import { MockChannelProvider } from "./mock-channel.js";

describe("MockChannelProvider", () => {
  it("returns the seeded raw bookings once, then nothing (drains its queue)", async () => {
    const seed: RawBooking[] = [{
      externalRef: "AB-1", channel: "airbnb", propertyExternalCode: "VILLA-SUD",
      guest: { name: "Ana", contact: "ana@x.com", locale: "en" },
      checkIn: "2026-07-10", checkOut: "2026-07-12", grossCents: 1, feesCents: 0,
    }];
    const provider = new MockChannelProvider(seed);
    expect(await provider.listNewBookings()).toHaveLength(1);
    expect(await provider.listNewBookings()).toHaveLength(0);
  });
});
