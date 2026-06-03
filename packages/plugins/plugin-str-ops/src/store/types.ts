import type { Booking, Guest, Owner, Property } from "../domain/types.js";

export interface NewGuest {
  companyId: string;
  name: string;
  contact: string;
  locale: Guest["locale"];
}

export interface NewBooking {
  companyId: string;
  propertyId: string;
  guestId: string;
  channel: string;
  status: Booking["status"];
  checkIn: string;
  checkOut: string;
  nights: number;
  grossCents: number;
  feesCents: number;
  externalRef: string;
}

export interface StrOpsStore {
  listProperties(companyId: string): Promise<Property[]>;
  getProperty(companyId: string, propertyId: string): Promise<Property | null>;
  getPropertyByExternalCode(companyId: string, externalCode: string): Promise<Property | null>;
  getOwner(companyId: string, ownerId: string): Promise<Owner | null>;
  upsertGuestByContact(guest: NewGuest): Promise<Guest>;
  findBookingByExternalRef(companyId: string, channel: string, externalRef: string): Promise<Booking | null>;
  findOverlappingBookings(companyId: string, propertyId: string, checkIn: string, checkOut: string): Promise<Booking[]>;
  insertBooking(booking: NewBooking): Promise<Booking>;
  listBookings(companyId: string, filter?: { propertyId?: string }): Promise<Booking[]>;
  // seed helpers (dev/demo)
  insertOwner(owner: Owner): Promise<Owner>;
  insertProperty(property: Property): Promise<Property>;
}
