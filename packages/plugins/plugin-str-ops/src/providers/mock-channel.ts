import type { RawBooking } from "../domain/types.js";
import type { ChannelProvider } from "./types.js";

/**
 * Deterministic mock channel. Yields its seeded raw bookings on first poll,
 * then an empty list, so a repeated `channel-poll` is idempotent in the PoC.
 */
export class MockChannelProvider implements ChannelProvider {
  private queue: RawBooking[];
  constructor(seed: RawBooking[]) {
    this.queue = [...seed];
  }
  async listNewBookings(): Promise<RawBooking[]> {
    const out = this.queue;
    this.queue = [];
    return out;
  }
}
