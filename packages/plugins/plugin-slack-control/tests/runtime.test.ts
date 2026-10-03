import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime, receiveEvent, type Connection, type TransportDiagnostics } from "../src/runtime.js";
import { company, config, database, envelope, host, initialise, namespace, otherCompany } from "./helpers.js";

const pg = new PGlite();
beforeAll(() => initialise(pg)); afterAll(() => pg.close());
beforeEach(() => pg.exec(`TRUNCATE ${namespace}.inbox, ${namespace}.threads`));
describe("acknowledgement and connection lifecycle", () => {
  it("counts received, accepted, ignored and failed delivery without recording payloads or identities", async () => {
    const diagnostics: TransportDiagnostics = { received: 0, accepted: 0, ignored: 0, failed: 0, lastReason: null };
    const ack = vi.fn().mockResolvedValue(undefined); const enqueue = vi.fn().mockResolvedValue(undefined);
    await receiveEvent(envelope(), ack, config, enqueue, diagnostics);
    expect(diagnostics).toEqual({ received: 1, accepted: 1, ignored: 0, failed: 0, lastReason: "accepted" });
    await receiveEvent(envelope({ user: "U_UNLISTED_PRIVATE" }), ack, config, enqueue, diagnostics);
    expect(diagnostics).toEqual({ received: 2, accepted: 1, ignored: 1, failed: 0, lastReason: "unsupported_or_untrusted_event" });
    enqueue.mockRejectedValueOnce(new Error("synthetic-private-provider-payload"));
    await expect(receiveEvent(envelope(), ack, config, enqueue, diagnostics)).rejects.toThrow();
    expect(diagnostics).toEqual({ received: 3, accepted: 2, ignored: 1, failed: 1, lastReason: "delivery_failed" });
    expect(ack).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(diagnostics)).not.toMatch(/UTEST|TTEST|DTEST|Ev001|private|Synthetic task/);
  });
  it("persists before acknowledging and never waits for task work", async () => {
    const calls: string[] = [];
    await receiveEvent(envelope(), async () => { calls.push("ack"); }, config, async () => { calls.push("persist"); });
    expect(calls).toEqual(["persist", "ack"]);
  });
  it("does not acknowledge failed persistence; rejects unsupported events without persisting", async () => {
    const ack = vi.fn(); const enqueue = vi.fn().mockRejectedValue(new Error("DB unavailable"));
    await expect(receiveEvent(envelope(), ack, config, enqueue)).rejects.toThrow();
    expect(ack).not.toHaveBeenCalled();
    enqueue.mockClear();
    await receiveEvent(envelope({ subtype: "bot_message" }), ack, config, enqueue);
    expect(ack).toHaveBeenCalledTimes(1); expect(enqueue).not.toHaveBeenCalled();
  });
  it("stays disconnected by default, closes before replacing, and prevents another company's configuration", async () => {
    const connections: Connection[] = [];
    const connect = vi.fn(async () => {
      const connection: Connection = { isConnected: () => true, start: vi.fn(), stop: vi.fn(), verifyDirectMessage: vi.fn().mockResolvedValue(true), reply: vi.fn() };
      connections.push(connection); return connection;
    });
    const { ctx } = host(database(pg)); const runtime = createRuntime(ctx, connect);
    try {
      await runtime.configure({}, company); expect(connect).not.toHaveBeenCalled();
      await runtime.configure(config, company); expect(runtime.health()).toBe("connected");
      await runtime.configure({ ...config, enabled: false }, company);
      expect(connections[0]?.stop).toHaveBeenCalledTimes(1); expect(runtime.health()).toBe("disabled");
      await expect(runtime.status(otherCompany)).rejects.toThrow("Company scope mismatch");
      await expect(runtime.configure(config, otherCompany)).rejects.toThrow();
      expect(connect).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });
  it("requires host company scope and reports connection failures without provider secrets", async () => {
    const { ctx, api } = host(database(pg));
    const connect = vi.fn().mockRejectedValue(new Error("xapp-private-provider-payload"));
    const runtime = createRuntime(ctx, connect);
    await expect(runtime.configure(config, null)).rejects.toThrow(); expect(connect).not.toHaveBeenCalled();
    await expect(runtime.configure(config, company)).rejects.toThrow("No credential or provider response");
    expect(runtime.health()).toBe("error");
    expect(JSON.stringify(api.logger.error.mock.calls)).not.toContain("xapp-private");
    await runtime.shutdown();
  });
  it("does not dispatch from a replaced connection", async () => {
    let receive: ((body: unknown, ack: () => Promise<void>) => Promise<void>) | undefined;
    const connection: Connection = { isConnected: () => true, start: vi.fn(async (handler) => { receive = handler; }), stop: vi.fn(), verifyDirectMessage: vi.fn(), reply: vi.fn() };
    const { ctx, api } = host(database(pg)); const runtime = createRuntime(ctx, async () => connection);
    await runtime.configure(config, company); await runtime.configure({ enabled: false }, company);
    const ack = vi.fn(); await receive!(envelope(), ack);
    expect(ack).not.toHaveBeenCalled(); expect(api.issues.create).not.toHaveBeenCalled();
    await runtime.shutdown();
  });
  it("exposes isolated counter snapshots and resets them for the next configuration", async () => {
    let receive!: (body: unknown, ack: () => Promise<void>) => Promise<void>;
    const connection: Connection = { isConnected: () => true, start: vi.fn(async (handler) => { receive = handler; }), stop: vi.fn(), verifyDirectMessage: vi.fn(), reply: vi.fn() };
    const { ctx } = host(database(pg)); const runtime = createRuntime(ctx, async () => connection);
    try {
      await runtime.configure(config, company);
      await receive(envelope({ user: "UOTHER" }), vi.fn());
      const first = await runtime.status(company);
      expect(first.diagnostics).toMatchObject({ received: 1, ignored: 1, lastReason: "unsupported_or_untrusted_event" });
      first.diagnostics.received = 999;
      expect((await runtime.status(company)).diagnostics.received).toBe(1);
      await runtime.configure(config, company);
      expect((await runtime.status(company)).diagnostics).toEqual({ received: 0, accepted: 0, ignored: 0, failed: 0, lastReason: null });
    } finally { await runtime.shutdown(); }
  });
  it("returns only authenticated bot metadata within the configured company", async () => {
    const authenticatedIdentity = { workspaceId: "TTEST", botUserId: "UBOT", botId: "BBOT", token: "synthetic-private-token" };
    const connection: Connection = { authenticatedIdentity, isConnected: () => true, start: vi.fn(), stop: vi.fn(), verifyDirectMessage: vi.fn(), reply: vi.fn() };
    const { ctx } = host(database(pg)); const runtime = createRuntime(ctx, async () => connection);
    try {
      expect((await runtime.status(company)).authenticatedIdentity).toBeNull();
      await runtime.configure(config, company);
      const status = await runtime.status(company);
      expect(status.authenticatedIdentity).toEqual({ workspaceId: "TTEST", botUserId: "UBOT", botId: "BBOT" });
      expect(JSON.stringify(status.authenticatedIdentity)).not.toContain("private");
      await expect(runtime.status(otherCompany)).rejects.toThrow("Company scope mismatch");
      await runtime.configure({ enabled: false }, company);
      expect((await runtime.status(company)).authenticatedIdentity).toBeNull();
    } finally { await runtime.shutdown(); }
  });
  it("keeps received commands queued while offline, then rechecks company membership after recovery", async () => {
    vi.useFakeTimers();
    let connected = false;
    let receive!: (body: unknown, ack: () => Promise<void>) => Promise<void>;
    const connection: Connection = { isConnected: () => connected, start: vi.fn(async (handler) => { receive = handler; }), stop: vi.fn(), verifyDirectMessage: vi.fn().mockResolvedValue(true), reply: vi.fn() };
    const { ctx, api } = host(database(pg)); const runtime = createRuntime(ctx, async () => connection);
    try {
      await runtime.configure(config, company);
      await receive(envelope({ text: "status" }), vi.fn());
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await runtime.status(company)).recent[0]?.phase).toBe("received");
      expect(api.access.members.list).not.toHaveBeenCalled();
      // Recovery does not bypass revocation that happened during the outage.
      api.access.members.list.mockResolvedValue([]); connected = true;
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(async () => expect((await runtime.status(company)).recent[0]?.phase).toBe("uncertain"));
      expect(api.access.members.list).toHaveBeenCalledWith({ companyId: company });
      expect(api.issues.list).not.toHaveBeenCalled(); expect(connection.reply).not.toHaveBeenCalled();
    } finally { await runtime.shutdown(); vi.useRealTimers(); }
  });
  it("awaits confirmed shutdown before replacement and refuses replacement if cleanup fails", async () => {
    let release!: () => void;
    const connection: Connection = { isConnected: () => false, start: vi.fn(), stop: vi.fn(() => new Promise<void>((resolve) => { release = resolve; })), verifyDirectMessage: vi.fn(), reply: vi.fn() };
    const connect = vi.fn(async () => connection);
    const { ctx } = host(database(pg)); const runtime = createRuntime(ctx, connect);
    await runtime.configure(config, company);
    const replacing = runtime.configure(config, company);
    await vi.waitFor(() => expect(connection.stop).toHaveBeenCalledTimes(1));
    expect(connect).toHaveBeenCalledTimes(1);
    release(); await replacing; expect(connect).toHaveBeenCalledTimes(2);
    vi.mocked(connection.stop).mockRejectedValue(new Error("synthetic-private-cleanup-error"));
    await expect(runtime.configure(config, company)).rejects.toThrow("No credential or provider response");
    expect(connect).toHaveBeenCalledTimes(2); expect(runtime.health()).toBe("error");
    vi.mocked(connection.stop).mockResolvedValue(undefined); await runtime.shutdown();
  });
  it("reports terminal connection failures to board status and health", async () => {
    const connection: Connection = { connectionStatus: () => ({ state: "error", lastFailure: "authentication_failed", retryAt: null }), isConnected: () => false, start: vi.fn(), stop: vi.fn(), verifyDirectMessage: vi.fn(), reply: vi.fn() };
    const { ctx } = host(database(pg)); const runtime = createRuntime(ctx, async () => connection);
    try {
      await runtime.configure(config, company);
      expect(runtime.health()).toBe("error");
      expect((await runtime.status(company)).connection).toEqual({ state: "error", lastFailure: "authentication_failed", retryAt: null });
      await expect(runtime.status(otherCompany)).rejects.toThrow("Company scope mismatch");
    } finally { await runtime.shutdown(); }
  });
});
