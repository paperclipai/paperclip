import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiConnectionLoginIntent } from "@paperclipai/shared";
import type { LocalBrowserLoginState } from "../services/local-ai-browser-login.js";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({ root: vi.fn(), browser: vi.fn(), credential: vi.fn(), save: vi.fn(), notify: vi.fn(), activity: vi.fn() }));
vi.mock("../home-paths.js", () => ({ resolvePaperclipInstanceRoot: mocks.root }));
vi.mock("../services/local-ai-browser-login.js", () => ({ startLocalBrowserLogin: mocks.browser }));
vi.mock("../services/local-ai-credentials.js", () => ({ readVerifiedLocalAiCredentialDetails: mocks.credential }));
vi.mock("../services/ai-connections.js", () => ({ aiConnectionService: () => ({ save: mocks.save }) }));
vi.mock("../services/delivery-work-notifications.js", () => ({ DELIVERY_QUEUES: { localLoginCleanup: "localLoginCleanup" }, notifyDeliveryWork: mocks.notify }));
vi.mock("../services/activity-log.js", () => ({ logActivity: mocks.activity }));
import { localAiLoginService } from "../services/local-ai-login.js";

const intent: AiConnectionLoginIntent = { provider: "google", method: "subscription", name: "Google account", ownership: "personal", allAgents: true, agentIds: [] };
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); vi.clearAllMocks(); });

// This suite exercises service ordering with an explicit transaction result
// queue. It does not replace database authorization/concurrency coverage; the
// native child/Google protocol has its own controlled-process Runner suite.
function database() {
  const selections: unknown[][] = [];
  let session: Record<string, any>;
  const db: any = {
    selections,
    expiredSessions: undefined as Record<string, any>[] | undefined,
    expiredReads: [] as Record<string, any>[],
    activeTransactions: 0,
    peakTransactions: 0,
    get session() { return session; },
    async transaction(run: (tx: unknown) => unknown) {
      db.activeTransactions += 1;
      db.peakTransactions = Math.max(db.peakTransactions, db.activeTransactions);
      try { return await run(db); }
      finally { db.activeTransactions -= 1; }
    },
    async execute() {},
    select(fields?: unknown) {
      let values: unknown[];
      let tableRows = false;
      if ((fields && db.expiredSessions) || db.expiryTable) {
        tableRows = true;
        values = [...db.expiredSessions];
      } else if (db.expiredReads.length) values = [db.expiredReads.shift()];
      else {
        if (!selections.length) throw new Error("Unexpected test database selection");
        values = selections.shift()!;
      }
      const result: any = { from: () => result, where: (condition: any) => {
        if (tableRows) {
          const query = new PgDialect().sqlToQuery(condition);
          const excluded = query.sql.includes("not in") ? query.params.filter(value => typeof value === "string" && value !== "local_subscription") : [];
          if (fields) values = values.filter((row: any) => row.expiresAt && !excluded.includes(row.id));
          else values = values.filter((row: any) => query.params.includes(row.id));
          if (query.sql.includes(" <= ")) values = values.filter((row: any) => row.expiresAt <= new Date());
        }
        return result;
      }, for: () => result, orderBy: () => result, limit: (count: number) => { values = values.slice(0, count); return result; },
        then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(tableRows && fields
          ? values.map((row: any) => (fields as any).at ? { at: row.expiresAt } : { id: row.id }) : values).then(resolve, reject) };
      return result;
    },
    insert() { return { async values(value: Record<string, unknown>) { session = { ...value, createdAt: new Date() }; } }; },
    update() { return { set(value: Record<string, unknown>) { return { async where(condition: any) {
      const params = new PgDialect().sqlToQuery(condition).params;
      const target = db.expiredSessions?.find((row: any) => params.includes(row.id)) ?? session;
      Object.assign(target, value);
    } }; } }; },
  };
  return db;
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-google-local-login-service-"))); roots.push(root);
  mocks.root.mockReturnValue(root);
  let release: () => void;
  const retirement = new Promise<void>(resolve => { release = resolve; });
  const browser: LocalBrowserLoginState = { authorizationUrl: "https://accounts.google.com/fixture", abort: vi.fn(() => retirement) };
  mocks.browser.mockReturnValue(browser);
  mocks.credential.mockResolvedValue({ credential: "private-native-credential", accountLabel: "person@example.test" });
  mocks.save.mockResolvedValue({ connectionId: "connection-1", grantId: "grant-1" });
  const db = database(), service = localAiLoginService(db);
  db.selections.push([], [{ id: "local-environment", driver: "local", status: "active" }]);
  const attempt = await service.start("company", "user", intent);
  const home = join(root, "ai-local-logins", attempt.sessionId);
  return { db, service, browser, attempt, home, release: release! };
}

describe("Google local sign-in service admission", () => {
  it("does not check or promote an early refresh-token file until native authenticate finishes", async () => {
    const f = await fixture();
    await mkdir(join(f.home, "antigravity-acp"), { mode: 0o700 });
    await writeFile(join(f.home, "antigravity-acp", "acp_token.json"), "early-native-token", { mode: 0o600 });
    f.db.selections.push([f.db.session]);
    expect(await f.service.check("company", "user", intent, f.attempt.sessionId)).toMatchObject({ status: "sign_in_required", authorizationUrl: f.browser.authorizationUrl });
    f.db.selections.push([f.db.session]);
    await expect(f.service.complete("company", "user", f.attempt.sessionId, intent)).rejects.toThrow("Finish Google browser sign-in");
    expect(mocks.credential).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    f.release(); f.db.selections.push([f.db.session], [f.db.session]); await f.service.cancel("company", "user", f.attempt.sessionId);
  });

  it("returns the verified account email and passes it to the saved connection", async () => {
    const f = await fixture(); f.browser.outcome = "success";
    f.db.selections.push([f.db.session]);
    expect(await f.service.check("company", "user", intent, f.attempt.sessionId)).toEqual({ status: "ready", accountLabel: "person@example.test" });
    f.release(); f.db.selections.push([f.db.session]);
    expect(await f.service.complete("company", "user", f.attempt.sessionId, intent)).toEqual({ connectionId: "connection-1", grantId: "grant-1" });
    expect(mocks.save).toHaveBeenCalledWith("company", "user", intent, "private-native-credential", { id: f.attempt.sessionId }, expect.any(Date), undefined, "person@example.test");
    await expect(access(f.home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a fresh browser exchange after server process state is lost", async () => {
    const db = database(), service = localAiLoginService(db);
    const session = { id: "unknown-browser-process", aiConnection: intent, status: "waiting_for_user", connectionMethod: "local_subscription", expiresAt: new Date(Date.now() + 60_000) };
    mocks.root.mockReturnValue(await realpath(tmpdir()));
    db.selections.push([session]);
    expect(await service.check("company", "user", intent, session.id)).toMatchObject({ status: "sign_in_required", error: "The server restarted during sign-in. Start sign-in again." });
    db.selections.push([session]);
    await expect(service.complete("company", "user", session.id, intent)).rejects.toThrow("Finish Google browser sign-in");
    expect(mocks.credential).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("starts another user's provider without waiting for a globally expired Google browser", async () => {
    const f = await fixture();
    f.db.session.expiresAt = new Date(Date.now() - 1);
    const other = database(), otherService = localAiLoginService(other);
    other.expiredSessions = [f.db.session];
    other.selections.push([], [{ id: "local-environment", driver: "local", status: "active" }]);
    mocks.browser.mockReturnValue({ abort: vi.fn() });
    let attempt: Awaited<ReturnType<typeof otherService.start>> | undefined;
    let failure: unknown;
    const starting = otherService.start("another-company", "another-user", { ...intent, provider: "openai" })
      .then(result => { attempt = result; }, error => { failure = error; });
    try {
      await vi.waitFor(() => { if (failure) throw failure; expect(attempt).toBeDefined(); });
      expect(f.browser.abort).not.toHaveBeenCalled();
      await expect(access(f.home)).resolves.toBeUndefined();
    } finally {
      f.release(); await starting;
      f.db.selections.push([f.db.session], [f.db.session]); await f.service.cancel("company", "user", f.attempt.sessionId);
      if (attempt) { other.selections.push([other.session], [other.session]); await otherService.cancel("another-company", "another-user", attempt.sessionId); }
    }
  });

  it("does not hold an expired attempt's database transaction while browser retirement is pending", async () => {
    const f = await fixture();
    f.db.session.expiresAt = new Date(Date.now() - 1);
    f.db.selections.push([{ id: f.attempt.sessionId }], [f.db.session]);
    const reaping = f.service.reapExpired();
    try {
      await vi.waitFor(() => expect(f.browser.abort).toHaveBeenCalledOnce());
      expect(f.db.activeTransactions).toBe(0);
      await expect(access(f.home)).resolves.toBeUndefined();
    } finally { f.release(); await reaping; }
    await expect(access(f.home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts retirement of other expired attempts while the first browser remains pending", async () => {
    const f = await fixture(), first = f.db.session;
    let release!: () => void;
    const retirement = new Promise<void>(resolve => { release = resolve; });
    const browser = { abort: vi.fn(() => retirement) };
    mocks.browser.mockReturnValue(browser);
    f.db.selections.push([], [{ id: "local-environment", driver: "local", status: "active" }]);
    const second = await f.service.start("company", "another-user", { ...intent, provider: "openai" });
    first.expiresAt = f.db.session.expiresAt = new Date(Date.now() - 1);
    f.db.selections.push([{ id: first.id }, { id: second.sessionId }], [first], [f.db.session]);
    const reaping = f.service.reapExpired();
    try {
      await vi.waitFor(() => { expect(f.browser.abort).toHaveBeenCalledOnce(); expect(browser.abort).toHaveBeenCalledOnce(); });
      expect(f.db.activeTransactions).toBe(0);
      await expect(access(f.home)).resolves.toBeUndefined();
      await expect(access(join(f.home, "..", second.sessionId))).resolves.toBeUndefined();
    } finally { f.release(); release(); await reaping; }
    await expect(access(f.home)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(f.home, "..", second.sessionId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds an expiry sweep and wakes the same worker only when retained physical retirement settles", async () => {
    const f = await fixture(), original = f.db.session;
    original.expiresAt = new Date(Date.now() - 1);
    const originalExpiry = original.expiresAt;
    f.db.expiredSessions = [original];
    f.db.expiryTable = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const reaping = f.service.reapExpired().then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(f.browser.abort).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(true);
      expect(original.status).toBe("waiting_for_user");
      expect(original.expiresAt).toBe(originalExpiry);
      expect(f.db.activeTransactions).toBe(0);
      await expect(access(f.home)).resolves.toBeUndefined();
      const wake = vi.fn(), otherWake = vi.fn();
      const unsubscribe = f.service.subscribeCleanupReady(wake);
      const unsubscribeOther = localAiLoginService(database()).subscribeCleanupReady(otherWake);
      try {
        // Pending physical ownership has no retry deadline or recurring SQL.
        expect(await f.service.nextCleanupAt()).toBeNull();
        const later = { ...original, id: "later-expired-attempt", expiresAt: new Date(Date.now() - 1) };
        f.db.expiredSessions.push(later);
        await mkdir(join(f.home, "..", later.id), { mode: 0o700 });
        await f.service.reapExpired();
        expect(later.status).toBe("timed_out");
        expect(original.status).toBe("waiting_for_user");
        expect(wake).not.toHaveBeenCalled();
        expect(await f.service.nextCleanupAt()).toBeNull();
        f.release();
        await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
        expect(otherWake).not.toHaveBeenCalled();
        expect(await f.service.nextCleanupAt()).toBe(originalExpiry.getTime());
        await f.service.reapExpired();
        expect(original.status).toBe("timed_out");
        await expect(access(f.home)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await f.service.nextCleanupAt()).toBeNull();
      } finally { unsubscribe(); unsubscribeOther(); }
    } finally { f.release(); await reaping; }
  });

  it("limits concurrent expiry cleanup transactions within a batch", async () => {
    const f = await fixture();
    f.release();
    const sessions = Array.from({ length: 16 }, (_, index) => ({ ...f.db.session,
      id: index ? `bounded-expiry-${index}` : f.attempt.sessionId, expiresAt: new Date(Date.now() - 1),
    }));
    await Promise.all(sessions.slice(1).map(session => mkdir(join(f.home, "..", session.id), { mode: 0o700 })));
    f.db.expiredSessions = sessions;
    f.db.expiryTable = true;
    await f.service.reapExpired();
    expect(sessions.every(session => session.status === "timed_out" && session.expiresAt === null)).toBe(true);
    expect(f.db.peakTransactions).toBeLessThanOrEqual(4);
    expect(await f.service.nextCleanupAt()).toBeNull();
  });

  it.each(["cancel", "restart"] as const)("bounds %s without holding a transaction and keeps the claim for maintenance", async action => {
    const f = await fixture();
    f.db.selections.push([f.db.session], [f.db.session]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let result: unknown;
    const operation = (action === "cancel" ? f.service.cancel("company", "user", f.attempt.sessionId)
      : f.service.start("company", "user", intent, true)).then(value => { result = value; }, error => { result = error; });
    try {
      await vi.waitFor(() => expect(f.browser.abort).toHaveBeenCalledOnce());
      expect(f.db.activeTransactions).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      await operation;
      expect(result).toMatchObject({ status: 422, details: { code: "ai_connection_busy" } });
      expect(f.db.session.status).toBe("waiting_for_user");
      expect(f.db.session.failureReason).toBe("local_login_retirement_pending");
      expect(f.db.session.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
      await expect(access(f.home)).resolves.toBeUndefined();
    } finally { vi.useRealTimers(); f.release(); await operation; }
    f.db.selections.push([{ id: f.attempt.sessionId }], [f.db.session]);
    await f.service.reapExpired();
    expect(f.db.session.status).toBe("cancelled");
    expect(f.db.session.expiresAt).toBeNull();
    await expect(access(f.home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["cancel", "expiry", "restart", "complete"] as const)("awaits physical browser retirement before deleting the login home on %s", async action => {
    const f = await fixture();
    let operation: Promise<unknown>;
    if (action === "cancel") {
      f.db.selections.push([f.db.session], [f.db.session]); operation = f.service.cancel("company", "user", f.attempt.sessionId);
    } else if (action === "expiry") {
      f.db.session.expiresAt = new Date(Date.now() - 1);
      f.db.selections.push([{ id: f.attempt.sessionId }], [f.db.session]); operation = f.service.reapExpired();
    } else if (action === "restart") {
      f.db.selections.push([f.db.session], [f.db.session], [{ id: "local-environment", driver: "local", status: "active" }]);
      operation = f.service.start("company", "user", intent, true);
    } else {
      f.browser.outcome = "success";
      f.db.selections.push([f.db.session]); operation = f.service.complete("company", "user", f.attempt.sessionId, intent);
    }
    await vi.waitFor(() => expect(f.browser.abort).toHaveBeenCalledOnce());
    await expect(access(f.home)).resolves.toBeUndefined();
    f.release(); await operation;
    await expect(access(f.home)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
