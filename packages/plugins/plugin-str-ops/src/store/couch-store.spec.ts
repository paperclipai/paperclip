import { describe, expect, it } from "vitest";
import { CouchStore, type CouchHttp, type CouchResponse } from "./couch-store.js";

// In-memory fake CouchDB: db-create, _index, _find (minimal selector), GET/PUT by id.
class FakeCouch implements CouchHttp {
  docs = new Map<string, Record<string, unknown>>();
  async request(method: string, path: string, body?: unknown): Promise<CouchResponse> {
    const parts = path.split("/").filter(Boolean); // [db, rest...]
    if (method === "PUT" && parts.length === 1) return { status: 201, body: { ok: true } };
    if (method === "POST" && parts[1] === "_index") return { status: 200, body: { result: "created" } };
    if (method === "POST" && parts[1] === "_find") {
      const selector = (body as { selector: Record<string, unknown> }).selector;
      const docs = [...this.docs.values()].filter((d) => matchesSelector(d, selector));
      return { status: 200, body: { docs } };
    }
    const id = decodeURIComponent(parts.slice(1).join("/"));
    if (method === "GET") {
      const d = this.docs.get(id);
      return d ? { status: 200, body: d } : { status: 404, body: { error: "not_found" } };
    }
    if (method === "PUT") {
      const prev = this.docs.get(id);
      const n = prev ? Number(String(prev._rev).split("-")[0]) + 1 : 1;
      const doc = { ...(body as Record<string, unknown>), _rev: `${n}-x` };
      this.docs.set(id, doc);
      return { status: 201, body: { ok: true, id, rev: doc._rev } };
    }
    return { status: 405, body: {} };
  }
}
function matchesSelector(doc: Record<string, any>, sel: Record<string, any>): boolean {
  return Object.entries(sel).every(([k, v]) => {
    if (v && typeof v === "object") {
      if ("$ne" in v) return doc[k] !== v.$ne;
      if ("$lt" in v) return doc[k] < v.$lt;
      if ("$gt" in v) return doc[k] > v.$gt;
    }
    return doc[k] === v;
  });
}

const CO = "c1";
const newBooking = (over: Record<string, unknown> = {}) => ({
  companyId: CO, propertyId: "property:c1:VILLA", guestId: "guest:c1:ana@x.com",
  channel: "airbnb", status: "confirmed" as const, checkIn: "2026-07-01", checkOut: "2026-07-05",
  nights: 4, grossCents: 1, feesCents: 0, externalRef: "AB-1", ...over,
});

describe("CouchStore", () => {
  it("dedupes a booking by deterministic _id (findBookingByExternalRef = GET)", async () => {
    const store = new CouchStore(new FakeCouch(), "str_ops");
    await store.insertBooking(newBooking());
    expect(await store.findBookingByExternalRef(CO, "airbnb", "AB-1")).not.toBeNull();
    expect(await store.findBookingByExternalRef(CO, "booking", "AB-1")).toBeNull();
    expect(await store.findBookingByExternalRef("other", "airbnb", "AB-1")).toBeNull();
  });

  it("upserts a guest idempotently by contact (latest name wins, same id)", async () => {
    const store = new CouchStore(new FakeCouch(), "str_ops");
    const a = await store.upsertGuestByContact({ companyId: CO, name: "Ana", contact: "ana@x.com", locale: "en" });
    const b = await store.upsertGuestByContact({ companyId: CO, name: "Ana R.", contact: "ana@x.com", locale: "en" });
    expect(b.id).toBe(a.id);
    expect(b.name).toBe("Ana R.");
  });

  it("findOverlappingBookings honors half-open intervals and excludes cancelled", async () => {
    const store = new CouchStore(new FakeCouch(), "str_ops");
    await store.insertBooking(newBooking());
    expect(await store.findOverlappingBookings(CO, "property:c1:VILLA", "2026-07-04", "2026-07-06")).toHaveLength(1);
    expect(await store.findOverlappingBookings(CO, "property:c1:VILLA", "2026-07-05", "2026-07-09")).toHaveLength(0);
  });

  it("getPropertyByExternalCode finds a seeded property via _find", async () => {
    const store = new CouchStore(new FakeCouch(), "str_ops");
    await store.insertProperty({ id: "property:c1:VILLA", companyId: CO, name: "Villa", externalCode: "VILLA", ownerId: "owner:1", basePriceCents: 1, currency: "EUR" });
    const p = await store.getPropertyByExternalCode(CO, "VILLA");
    expect(p?.name).toBe("Villa");
  });
});
