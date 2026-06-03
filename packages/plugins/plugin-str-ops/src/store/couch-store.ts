import type { Booking, Guest, Owner, Property } from "../domain/types.js";
import type { NewBooking, NewGuest, StrOpsStore } from "./types.js";

export interface CouchResponse {
  status: number;
  body: any;
}

/** Minimal CouchDB HTTP surface. `path` is relative to the server root, e.g. "/str_ops/owner:1".
 *  Production adapter (Task 7) wraps `ctx.http` + base URL + Basic auth; tests use a fake. */
export interface CouchHttp {
  request(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<CouchResponse>;
}

const enc = encodeURIComponent;

export class CouchStore implements StrOpsStore {
  constructor(private readonly http: CouchHttp, private readonly db = "str_ops") {}

  /** Create the database + Mango indexes if missing. Idempotent (existing db/index = no-op). */
  async ensure(): Promise<void> {
    const dbR = await this.http.request("PUT", `/${this.db}`);
    if (dbR.status !== 201 && dbR.status !== 202 && dbR.status !== 200 && dbR.status !== 412) {
      throw new Error(`CouchDB ensure: PUT /${this.db} failed: ${dbR.status} ${JSON.stringify(dbR.body)}`);
    }
    const indexes = [
      { index: { fields: ["type", "companyId"] }, name: "type-company", ddoc: "str-ops" },
      { index: { fields: ["type", "companyId", "propertyId"] }, name: "type-company-property", ddoc: "str-ops" },
      { index: { fields: ["type", "companyId", "externalCode"] }, name: "type-company-extcode", ddoc: "str-ops" },
    ];
    for (const idx of indexes) {
      const r = await this.http.request("POST", `/${this.db}/_index`, idx);
      if (r.status !== 200 && r.status !== 201) {
        throw new Error(`CouchDB ensure: _index ${idx.name} failed: ${r.status} ${JSON.stringify(r.body)}`);
      }
    }
  }

  private async getDoc(id: string): Promise<any | null> {
    const r = await this.http.request("GET", `/${this.db}/${enc(id)}`);
    if (r.status === 200) return r.body;
    if (r.status === 404) return null;
    throw new Error(`CouchDB GET ${id} failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  private async putDoc(doc: Record<string, unknown> & { _id: string }): Promise<any> {
    const r = await this.http.request("PUT", `/${this.db}/${enc(doc._id)}`, doc);
    if (r.status >= 400) throw new Error(`couch PUT ${doc._id} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return { ...doc, _rev: r.body?.rev };
  }
  private async find(selector: Record<string, unknown>): Promise<any[]> {
    const r = await this.http.request("POST", `/${this.db}/_find`, { selector, limit: 100000 });
    if (r.status >= 400) throw new Error(`couch _find failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body?.docs ?? [];
  }

  private guestId(companyId: string, contact: string) { return `guest:${encodeURIComponent(companyId)}:${encodeURIComponent(contact)}`; }
  private bookingId(companyId: string, channel: string, externalRef: string) { return `booking:${encodeURIComponent(companyId)}:${encodeURIComponent(channel)}:${encodeURIComponent(externalRef)}`; }

  private toOwner(d: any): Owner { return { id: d._id, companyId: d.companyId, name: d.name, email: d.email, commissionPct: d.commissionPct }; }
  private toProperty(d: any): Property { return { id: d._id, companyId: d.companyId, name: d.name, externalCode: d.externalCode, ownerId: d.ownerId, basePriceCents: d.basePriceCents, currency: d.currency }; }
  private toGuest(d: any): Guest { return { id: d._id, companyId: d.companyId, name: d.name, contact: d.contact, locale: d.locale === "fr" ? "fr" : "en" }; }
  private toBooking(d: any): Booking { return { id: d._id, companyId: d.companyId, propertyId: d.propertyId, guestId: d.guestId, channel: d.channel, status: d.status, checkIn: d.checkIn, checkOut: d.checkOut, nights: d.nights, grossCents: d.grossCents, feesCents: d.feesCents, externalRef: d.externalRef }; }

  async listProperties(companyId: string): Promise<Property[]> {
    return (await this.find({ type: "property", companyId })).map((d) => this.toProperty(d));
  }
  async getProperty(companyId: string, propertyId: string): Promise<Property | null> {
    const d = await this.getDoc(propertyId);
    return d && d.type === "property" && d.companyId === companyId ? this.toProperty(d) : null;
  }
  async getPropertyByExternalCode(companyId: string, externalCode: string): Promise<Property | null> {
    const docs = await this.find({ type: "property", companyId, externalCode });
    return docs[0] ? this.toProperty(docs[0]) : null;
  }
  async getOwner(companyId: string, ownerId: string): Promise<Owner | null> {
    const d = await this.getDoc(ownerId);
    return d && d.type === "owner" && d.companyId === companyId ? this.toOwner(d) : null;
  }
  async upsertGuestByContact(guest: NewGuest): Promise<Guest> {
    const _id = this.guestId(guest.companyId, guest.contact);
    const existing = await this.getDoc(_id);
    const saved = await this.putDoc({ _id, ...(existing?._rev ? { _rev: existing._rev } : {}), type: "guest", companyId: guest.companyId, name: guest.name, contact: guest.contact, locale: guest.locale });
    return this.toGuest(saved);
  }
  async findBookingByExternalRef(companyId: string, channel: string, externalRef: string): Promise<Booking | null> {
    const d = await this.getDoc(this.bookingId(companyId, channel, externalRef));
    return d && d.type === "booking" ? this.toBooking(d) : null;
  }
  async findOverlappingBookings(companyId: string, propertyId: string, checkIn: string, checkOut: string): Promise<Booking[]> {
    const docs = await this.find({ type: "booking", companyId, propertyId, status: { $ne: "cancelled" }, checkIn: { $lt: checkOut }, checkOut: { $gt: checkIn } });
    return docs.map((d) => this.toBooking(d));
  }
  async insertBooking(b: NewBooking): Promise<Booking> {
    const _id = this.bookingId(b.companyId, b.channel, b.externalRef);
    const saved = await this.putDoc({ _id, type: "booking", ...b });
    return this.toBooking(saved);
  }
  async listBookings(companyId: string, filter?: { propertyId?: string }): Promise<Booking[]> {
    const selector: Record<string, unknown> = { type: "booking", companyId };
    if (filter?.propertyId) selector.propertyId = filter.propertyId;
    return (await this.find(selector)).map((d) => this.toBooking(d));
  }
  async insertOwner(o: Owner): Promise<Owner> {
    const saved = await this.putDoc({ _id: o.id, type: "owner", ...o });
    return this.toOwner(saved);
  }
  async insertProperty(p: Property): Promise<Property> {
    const saved = await this.putDoc({ _id: p.id, type: "property", ...p });
    return this.toProperty(saved);
  }
}
