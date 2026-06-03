import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./store/memory-store.js";
import { MockChannelProvider } from "./providers/mock-channel.js";
import { registerStrOps, type RegisterDeps } from "./register.js";

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
    const res = await ctx._maps.tools.get("list_properties")!({ companyId: CO });
    expect(res.data.properties).toHaveLength(1);
  });
});
