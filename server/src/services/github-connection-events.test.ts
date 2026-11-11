import { describe, expect, it, vi } from "vitest";
import { chatEndpoints, type Db } from "@paperclipai/db";
import { githubConnectionEventService } from "./github-connection-events.js";
import { registerSlackFormWorkOwner } from "./chat-channels/slack/form-owner.js";
import type { PaperclipCloudConnector } from "./paperclip-cloud-connector.js";

function fixture(push = false, forcePolling = false) {
  let time = Date.parse("2026-09-04T12:00:00Z"), negotiated = push;
  const bindings = [{
    grant: { id: "grant", companyId: "company", kind: "user", subjectUserId: "owner", status: "active",
      providerTenant: { github: { installationIds: ["101"] } } },
    connection: { id: "connection", config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } } },
  }];
  const bots: Array<{ companyId: string }> = [];
  // Only SQL is stubbed. Backoff, lease admission and concurrent execution use
  // the real service; relational persistence has its own Postgres suite.
  const result = <T>(rows: T[]) => Object.assign(Promise.resolve(rows), { limit: async () => rows.slice(0, 1) });
  const select = vi.fn(() => ({ from: (table: unknown) => table === chatEndpoints
    ? { where: () => result(bots) }
    : { innerJoin: () => ({ where: () => result(bindings) }) } }));
  const leaseEvents = vi.fn<PaperclipCloudConnector["leaseEvents"]>().mockResolvedValue(null);
  const connector = { leaseEvents, eventWakeVersion: () => negotiated ? 1 : null } as unknown as PaperclipCloudConnector;
  const db = { select } as unknown as Db;
  const service = githubConnectionEventService(db, { connector, env: forcePolling ? { PAPERCLIP_GITHUB_EVENT_POLLING: "1" } : {}, now: () => new Date(time) });
  return { db, service, leaseEvents, select, bots, bindings, advance: (ms: number) => { time += ms; }, confirm: (value: boolean) => { negotiated = value; } };
}

describe("GitHub event polling during active App setup", () => {
  it("reaches Cloud during an old empty-queue backoff without expanding idle polling", async () => {
    const f = fixture();
    for (const delay of [0, 10_000, 20_000, 40_000, 80_000]) {
      f.advance(delay);
      await f.service.pollOnce();
    }
    expect(f.leaseEvents).toHaveBeenCalledTimes(5);
    const queries = f.select.mock.calls.length;
    f.bots.push({ companyId: "company" });
    f.advance(5_000);
    for (let index = 0; index < 3; index++) await f.service.pollOnce();
    expect(f.select).toHaveBeenCalledTimes(queries);
    expect(f.leaseEvents).toHaveBeenCalledTimes(5);
    await f.service.pollOnce({ forSetup: true });
    expect(f.leaseEvents).toHaveBeenCalledTimes(6);
    const setupQueries = f.select.mock.calls.length;
    await f.service.pollOnce({ forSetup: true });
    expect(f.leaseEvents).toHaveBeenCalledTimes(6);
    expect(f.select).toHaveBeenCalledTimes(setupQueries);
    f.advance(5_000);
    await f.service.pollOnce({ forSetup: true });
    expect(f.leaseEvents).toHaveBeenCalledTimes(7);
  });

  it("shares one lease between setup and scheduled callers while Cloud is slow", async () => {
    const f = fixture();
    let complete!: (value: null) => void;
    f.leaseEvents.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const scheduled = f.service.pollOnce();
    const setup = f.service.pollOnce({ forSetup: true });
    await vi.waitFor(() => expect(f.leaseEvents).toHaveBeenCalledTimes(1));
    expect(complete).toBeTypeOf("function");
    complete(null);
    await Promise.all([scheduled, setup]);
    expect(f.leaseEvents).toHaveBeenCalledTimes(1);
  });

  it("releases the shared attempt after an error and retries only after the setup throttle", async () => {
    const f = fixture();
    f.leaseEvents.mockRejectedValueOnce(new Error("Cloud unavailable"));
    await expect(f.service.pollOnce({ forSetup: true })).rejects.toThrow("Cloud unavailable");
    await f.service.pollOnce({ forSetup: true });
    await f.service.pollOnce();
    expect(f.leaseEvents).toHaveBeenCalledTimes(1);
    f.advance(5_000);
    await f.service.pollOnce({ forSetup: true });
    expect(f.leaseEvents).toHaveBeenCalledTimes(2);
  });
});

describe("GitHub external delivery activation", () => {
  it("does no SQL/network with no connector configuration after startup or cadence windows", async () => {
    const select = vi.fn(() => { throw new Error("unconfigured worker touched SQL"); });
    const db = { select } as unknown as Db;
  const service = githubConnectionEventService(db, { env: {} });
    for (let i = 0; i < 4; i++) await service.pollOnce({ forDelivery: true });
    expect(service.nextPollAt()).toBeNull(); expect(select).not.toHaveBeenCalled();
  });
  it("settles configured-idle after enrollment and wakes only on explicit delivery hints", async () => {
    const f = fixture(true);
    await f.service.pollOnce(); expect(f.service.nextPollAt()).toBeNull();
    const reads = f.select.mock.calls.length;
    for (let i = 0; i < 4; i++) { f.advance(300_000); await f.service.pollOnce(); }
    expect(f.select).toHaveBeenCalledTimes(reads); expect(f.leaseEvents).toHaveBeenCalledTimes(1);
    await f.service.pollOnce({ forDelivery: true }); expect(f.leaseEvents).toHaveBeenCalledTimes(2);
    expect(f.service.nextPollAt()).toBeNull();
  });
  it("arms forced fallback before a failed Cloud enrollment revocation", async () => {
    const f = fixture(true, true);
    f.leaseEvents.mockRejectedValueOnce(new Error("handoff unavailable"));
    await expect(f.service.pollOnce()).rejects.toThrow("handoff unavailable");
    expect(f.service.nextPollAt()).not.toBeNull();
    expect(f.leaseEvents.mock.calls[0]![0].eventWakeVersion).toBe(0);
    f.advance(5_000); await f.service.pollOnce();
    expect(f.leaseEvents).toHaveBeenCalledTimes(2); expect(f.service.nextPollAt()).not.toBeNull();
  });
  it("retains old-Cloud fallback and settles once all bindings are disabled", async () => {
    const f = fixture(); await f.service.pollOnce(); expect(f.service.nextPollAt()).not.toBeNull();
    f.bindings.length = 0; f.advance(10_000); await f.service.pollOnce();
    expect(f.service.nextPollAt()).toBeNull(); const reads = f.select.mock.calls.length;
    f.advance(3600_000); await f.service.pollOnce(); expect(f.select).toHaveBeenCalledTimes(reads);
  });
});


describe("connection event negotiation frontier", () => {
  it("wakes from empty Infinity and coalesces new consumer joins until actual negotiation", async () => {
    const f = fixture(), binding = f.bindings[0]!; f.bindings.length = 0;
    await f.service.pollOnce({ forDelivery: true });
    expect(f.service.nextPollAt()).toBeNull(); expect(f.leaseEvents).not.toHaveBeenCalled();
    f.bindings.push(binding);
    const owner = new AbortController(), joined = f.service.joinEventWakeEnrollment(owner.signal);
    try {
      for (let i = 0; i < 100; i++) expect(f.service.joinEventWakeEnrollment(owner.signal)).toBe(joined);
      expect(f.service.nextPollAt()).not.toBeNull();
      f.leaseEvents.mockImplementationOnce(async () => { f.confirm(true); return null; });
      await f.service.pollOnce({ forDelivery: true }); await joined;
      expect(f.leaseEvents).toHaveBeenCalledTimes(1);
      expect(f.leaseEvents.mock.calls[0]![0]).toMatchObject({ subject: "owner", companyId: "company", eventWakeVersion: 1 });
      expect(f.service.nextPollAt()).toBeNull();
    } finally { owner.abort(); }
  });

  it("joins an outstanding signed lease before its normal pass can finish draining", async () => {
    const f = fixture(); let entered!: () => void, answer!: () => void, finish!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const answered = new Promise<void>(resolve => { answer = resolve; });
    const draining = new Promise<void>(resolve => { finish = resolve; });
    f.leaseEvents.mockImplementationOnce(async () => { entered(); await answered; f.confirm(true); return null; });
    const stopWork = registerSlackFormWorkOwner(f.db, async () => { await draining; return null; });
    const polling = f.service.pollOnce({ forDelivery: true }), owner = new AbortController();
    try {
      await entering; const joined = f.service.joinEventWakeEnrollment(owner.signal); answer(); await joined;
      // SQL-only normal finally is still held. Readiness never joins the drain.
      let completed = false; void polling.then(() => { completed = true; });
      expect(completed).toBe(false);
    } finally { answer(); finish(); owner.abort(); await polling; stopWork(); }
  });

  it("assigns a post-response request to the next pass and preserves fallback refusal", async () => {
    const f = fixture(); let reached!: () => void, release!: () => void;
    const atFinally = new Promise<void>(resolve => { reached = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    const stopWork = registerSlackFormWorkOwner(f.db, async () => { reached(); await finish; throw new Error("old unrelated finally failure"); });
    f.leaseEvents.mockResolvedValueOnce(null);
    const previous = f.service.pollOnce({ forDelivery: true }), owner = new AbortController();
    try {
      await atFinally;
      const joined = f.service.joinEventWakeEnrollment(owner.signal); let settled = false;
      void joined.then(() => { settled = true; }, () => { settled = true; });
      release(); await previous; expect(settled).toBe(false);
      f.leaseEvents.mockImplementationOnce(async () => { f.confirm(true); return null; });
      await f.service.pollOnce({ forDelivery: true }); await joined;
      expect(f.leaseEvents).toHaveBeenCalledTimes(2);
    } finally { release(); owner.abort(); await previous; stopWork(); }
    const fallback = fixture(true, true), abort = new AbortController();
    await expect(fallback.service.joinEventWakeEnrollment(abort.signal)).rejects.toThrow("polling fallback");
    await fallback.service.pollOnce({ forDelivery: true });
    expect(fallback.leaseEvents.mock.calls[0]![0].eventWakeVersion).toBe(0);
  });
});
