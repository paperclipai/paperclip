import { randomUUID } from "node:crypto";
import type { Booking, Guest, Owner, Property } from "../domain/types.js";
import type { NewBooking, NewGuest, StrOpsStore } from "./types.js";

export class MemoryStore implements StrOpsStore {
  private owners: Owner[] = [];
  private properties: Property[] = [];
  private guests: Guest[] = [];
  private bookings: Booking[] = [];

  async listProperties(companyId: string): Promise<Property[]> {
    return this.properties.filter((p) => p.companyId === companyId);
  }
  async getProperty(companyId: string, propertyId: string): Promise<Property | null> {
    return this.properties.find((p) => p.companyId === companyId && p.id === propertyId) ?? null;
  }
  async getPropertyByExternalCode(companyId: string, externalCode: string): Promise<Property | null> {
    return this.properties.find((p) => p.companyId === companyId && p.externalCode === externalCode) ?? null;
  }
  async getOwner(companyId: string, ownerId: string): Promise<Owner | null> {
    return this.owners.find((o) => o.companyId === companyId && o.id === ownerId) ?? null;
  }
  async upsertGuestByContact(guest: NewGuest): Promise<Guest> {
    const existing = this.guests.find((g) => g.companyId === guest.companyId && g.contact === guest.contact);
    if (existing) {
      existing.name = guest.name;
      existing.locale = guest.locale;
      return existing;
    }
    const created: Guest = { id: randomUUID(), ...guest };
    this.guests.push(created);
    return created;
  }
  async findBookingByExternalRef(companyId: string, channel: string, externalRef: string): Promise<Booking | null> {
    return (
      this.bookings.find(
        (b) => b.companyId === companyId && b.channel === channel && b.externalRef === externalRef,
      ) ?? null
    );
  }
  async findOverlappingBookings(
    companyId: string,
    propertyId: string,
    checkIn: string,
    checkOut: string,
  ): Promise<Booking[]> {
    return this.bookings.filter(
      (b) =>
        b.companyId === companyId &&
        b.propertyId === propertyId &&
        b.status !== "cancelled" &&
        b.checkIn < checkOut &&
        b.checkOut > checkIn,
    );
  }
  async insertBooking(booking: NewBooking): Promise<Booking> {
    const created: Booking = { id: randomUUID(), ...booking };
    this.bookings.push(created);
    return created;
  }
  async listBookings(companyId: string, filter?: { propertyId?: string }): Promise<Booking[]> {
    return this.bookings.filter(
      (b) => b.companyId === companyId && (!filter?.propertyId || b.propertyId === filter.propertyId),
    );
  }
  async insertOwner(owner: Owner): Promise<Owner> {
    this.owners.push(owner);
    return owner;
  }
  async insertProperty(property: Property): Promise<Property> {
    this.properties.push(property);
    return property;
  }
}
