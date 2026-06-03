export type Locale = "fr" | "en";
export type BookingStatus = "pending" | "confirmed" | "cancelled";

export interface Owner {
  id: string;
  companyId: string;
  name: string;
  email: string;
  commissionPct: number;
}

export interface Property {
  id: string;
  companyId: string;
  name: string;
  externalCode: string; // channel-side code used to resolve raw bookings
  ownerId: string;
  basePriceCents: number;
  currency: string;
}

export interface Guest {
  id: string;
  companyId: string;
  name: string;
  contact: string;
  locale: Locale;
}

export interface Booking {
  id: string;
  companyId: string;
  propertyId: string;
  guestId: string;
  channel: string;
  status: BookingStatus;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  nights: number;
  grossCents: number;
  feesCents: number;
  externalRef: string;
}

// What a channel provider yields before resolution to internal ids.
export interface RawBooking {
  externalRef: string;
  channel: string;
  propertyExternalCode: string;
  guest: { name: string; contact: string; locale: Locale };
  checkIn: string;
  checkOut: string;
  grossCents: number;
  feesCents: number;
}
