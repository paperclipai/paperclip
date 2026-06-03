import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./store/memory-store.js";
import { MockChannelProvider } from "./providers/mock-channel.js";
import { registerStrOps, type RegisterDeps } from "./register.js";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";

/** Build a minimal ToolRunContext scoped to the given companyId. */
function runCtx(companyId: string): ToolRunContext {
  return { agentId: "agent-1", runId: "run-1", companyId, projectId: "proj-1" };
}

const FOREIGN = "company-foreign";

function fakeCtx() {
  const tools = new Map<string, Function>();
  const jobs = new Map<string, Function>();
  const data = new Map<string, Function>();
  const actions = new Map<string, Function>();
  return {
    tools: { register: (name: string, _def: unknown, fn: Function) => tools.set(name, fn) },
    jobs: { register: (key: string, fn: Function) => jobs.set(key, fn) },
    data: { register: (key: string, fn: Function) => data.set(key, fn) },
    actions: { register: (key: string, fn: Function) => actions.set(key, fn) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    _maps: { tools, jobs, data, actions },
  };
}

const CO = "company-1";

describe("registerStrOps", () => {
  it("registers the booking-spine tools, the channel-poll job, and health data", () => {
    const ctx = fakeCtx();
    const deps: RegisterDeps = {
      defaultCompanyId: CO,
      store: new MemoryStore(),
      channelProvider: new MockChannelProvider([]),
    };
    registerStrOps(ctx as never, deps);
    expect([...ctx._maps.tools.keys()].sort()).toEqual(
      ["check_availability", "get_owner", "list_bookings", "list_properties", "upsert_booking"],
    );
    expect([...ctx._maps.jobs.keys()]).toContain("channel-poll");
    expect([...ctx._maps.data.keys()]).toContain("health");
  });

  it("channel-poll job ingests seeded bookings into the store", async () => {
    const ctx = fakeCtx();
    const store = new MemoryStore();
    await store.insertOwner({ id: "o1", companyId: CO, name: "O", email: "o@x.com", commissionPct: 20 });
    await store.insertProperty({ id: "p1", companyId: CO, name: "Villa", externalCode: "VILLA-SUD", ownerId: "o1", basePriceCents: 1, currency: "EUR" });
    const channelProvider = new MockChannelProvider([{
      externalRef: "AB-1", channel: "airbnb", propertyExternalCode: "VILLA-SUD",
      guest: { name: "Ana", contact: "ana@x.com", locale: "en" },
      checkIn: "2026-07-10", checkOut: "2026-07-14", grossCents: 80000, feesCents: 8000,
    }]);
    registerStrOps(ctx as never, { defaultCompanyId: CO, store, channelProvider });
    await ctx._maps.jobs.get("channel-poll")!({ jobKey: "channel-poll", runId: "r1", trigger: "manual", scheduledAt: "" });
    expect(await store.listBookings(CO)).toHaveLength(1);
  });

  it("list_properties tool returns store rows for the company", async () => {
    const ctx = fakeCtx();
    const store = new MemoryStore();
    await store.insertOwner({ id: "o1", companyId: CO, name: "O", email: "o@x.com", commissionPct: 20 });
    await store.insertProperty({ id: "p1", companyId: CO, name: "Villa", externalCode: "V", ownerId: "o1", basePriceCents: 1, currency: "EUR" });
    registerStrOps(ctx as never, { defaultCompanyId: CO, store, channelProvider: new MockChannelProvider([]) });
    const res = await ctx._maps.tools.get("list_properties")!({ companyId: CO }, runCtx(CO));
    expect(res.data.properties).toHaveLength(1);
  });

  // P1-A: cross-company scope guard — foreign companyId rejected
  it("P1-A: rejects a caller companyId that mismatches run-context company", async () => {
    const ctx = fakeCtx();
    const store = new MemoryStore();
    await store.insertOwner({ id: "o1", companyId: CO, name: "O", email: "o@x.com", commissionPct: 20 });
    await store.insertProperty({ id: "p1", companyId: CO, name: "Villa", externalCode: "V", ownerId: "o1", basePriceCents: 1, currency: "EUR" });
    registerStrOps(ctx as never, { defaultCompanyId: CO, store, channelProvider: new MockChannelProvider([]) });

    const res = await ctx._maps.tools.get("list_properties")!({ companyId: FOREIGN }, runCtx(CO));
    expect(res.data.error).toBe("company_scope_violation");
    expect(res.data.properties).toBeUndefined();
  });

  // P1-A: omitting companyId falls back to run-context company
  it("P1-A: omitting companyId in params still works (uses run-context company)", async () => {
    const ctx = fakeCtx();
    const store = new MemoryStore();
    await store.insertOwner({ id: "o1", companyId: CO, name: "O", email: "o@x.com", commissionPct: 20 });
    await store.insertProperty({ id: "p1", companyId: CO, name: "Villa", externalCode: "V", ownerId: "o1", basePriceCents: 1, currency: "EUR" });
    registerStrOps(ctx as never, { defaultCompanyId: CO, store, channelProvider: new MockChannelProvider([]) });

    const res = await ctx._maps.tools.get("list_properties")!({}, runCtx(CO));
    expect(res.data.properties).toHaveLength(1);
  });

  // P1-A: scope guard applied to upsert_booking too
  it("P1-A: rejects foreign companyId on upsert_booking", async () => {
    const ctx = fakeCtx();
    const store = new MemoryStore();
    registerStrOps(ctx as never, { defaultCompanyId: CO, store, channelProvider: new MockChannelProvider([]) });

    const res = await ctx._maps.tools.get("upsert_booking")!({
      companyId: FOREIGN, propertyId: "p1", channel: "direct", externalRef: "X1",
      checkIn: "2026-08-01", checkOut: "2026-08-05", guestName: "Bob", guestContact: "b@x.com",
    }, runCtx(CO));
    expect(res.data.error).toBe("company_scope_violation");
    expect(await store.listBookings(CO)).toHaveLength(0);
  });

  // P1-B: property-exists check before upsert
  it("P1-B: upsert_booking with unknown propertyId returns unknownProperty:true and creates nothing", async () => {
    const ctx = fakeCtx();
    const store = new MemoryStore();
    registerStrOps(ctx as never, { defaultCompanyId: CO, store, channelProvider: new MockChannelProvider([]) });

    const res = await ctx._maps.tools.get("upsert_booking")!({
      propertyId: "no-such-property", channel: "direct", externalRef: "Y1",
      checkIn: "2026-08-01", checkOut: "2026-08-05", guestName: "Bob", guestContact: "b@x.com",
    }, runCtx(CO));
    expect(res.data.unknownProperty).toBe(true);
    expect(res.data.created).toBeNull();
    expect(await store.listBookings(CO)).toHaveLength(0);
  });

  // P1-B: property-exists — happy path
  it("P1-B: upsert_booking proceeds when the property exists", async () => {
    const ctx = fakeCtx();
    const store = new MemoryStore();
    await store.insertOwner({ id: "o1", companyId: CO, name: "O", email: "o@x.com", commissionPct: 20 });
    await store.insertProperty({ id: "p1", companyId: CO, name: "Villa", externalCode: "V", ownerId: "o1", basePriceCents: 1, currency: "EUR" });
    registerStrOps(ctx as never, { defaultCompanyId: CO, store, channelProvider: new MockChannelProvider([]) });

    const res = await ctx._maps.tools.get("upsert_booking")!({
      propertyId: "p1", channel: "direct", externalRef: "Z1",
      checkIn: "2026-08-01", checkOut: "2026-08-05", guestName: "Bob", guestContact: "b@x.com",
    }, runCtx(CO));
    expect(res.data.created).not.toBeNull();
    expect(await store.listBookings(CO)).toHaveLength(1);
  });
});
