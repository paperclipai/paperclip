import type { RawBooking } from "../domain/types.js";

export interface ChannelProvider {
  /** Return raw bookings observed since the plugin last polled. */
  listNewBookings(): Promise<RawBooking[]>;
}

// Declared now for the real bridge; mock impls land with their loops in later plans.
export interface MessagingProvider {
  sendMessage(input: { to: string; body: string; locale: string }): Promise<{ id: string }>;
}
export interface PaymentProvider {
  recordCharge(input: { amountCents: number; currency: string; ref: string }): Promise<{ id: string }>;
}
