import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { adapterAuthSessions, companies, companyMemberships, createDb, environments } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { localAiLoginService } from "../services/local-ai-login.js";
import { createDbSetupTokenCleanupStore } from "../services/setup-token-session.js";
import { createSetupTokenReaper } from "../services/setup-token-reaper.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

vi.mock("../services/local-ai-browser-login.js", () => ({
  startLocalBrowserLogin: () => ({
    authorizationUrl: "https://claude.ai/oauth/authorize",
    code: undefined,
    submitCode: vi.fn(),
    abort: vi.fn(),
  }),
}));

// A Claude local sign-in attempt is a row on the shared login-session table, but it
// holds no sandbox lease. The setup-token reaper must neither pick that row up nor
// fail on it: a pick-up would call the lease release with an empty lease id, which
// can never succeed, so the reaper would retry the row on every sweep for ever.

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const owner = "renewal-owner";
const intent = {
  provider: "anthropic",
  method: "subscription",
  name: "Claude subscription",
  ownership: "personal",
  agentIds: [],
  allAgents: true,
} as const;
const credentialFor = (id: string) =>
  path.join(resolvePaperclipInstanceRoot(), "ai-local-logins", id, ".credentials.json");

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "local-login-lease-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  database = await startEmbeddedPostgresTestDatabase("local-login-lease-db-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Renewal", issuePrefix: "REN" });
  await db.insert(companyMemberships).values({
    companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "owner",
  });
  await db.insert(environments).values({ name: "Local renewal", driver: "local" }).onConflictDoNothing();
}, 90000);
afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

function sweepWith(releaseById: (leaseId: string) => Promise<void>, lines: string[] = []) {
  return createSetupTokenReaper({
    store: createDbSetupTokenCleanupStore(db),
    leases: { releaseById },
    log: (line) => lines.push(line),
  });
}

describe("Claude local sign-in attempts and the setup-token reaper", () => {
  it("leaves no reapable record after a restart-cancel and a completed attempt", async () => {
    const login = localAiLoginService(db);
    const releaseById = vi.fn(async () => {});
    const reaper = sweepWith(releaseById);
    let first = await login.start(companyId, owner, intent);
    // Ten renewals: each restarts the open attempt, then completes the new one.
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const restarted = await login.start(companyId, owner, intent, true);
      expect(restarted.sessionId).not.toBe(first.sessionId);
      const [cancelled] = await db.select().from(adapterAuthSessions).where(eq(adapterAuthSessions.id, first.sessionId));
      expect(cancelled.status).toBe("cancelled");
      await writeFile(credentialFor(restarted.sessionId), JSON.stringify({
        claudeAiOauth: { accessToken: `access-${cycle}`, refreshToken: `refresh-${cycle}`, expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"] },
      }), { mode: 0o600 });
      await login.complete(companyId, owner, restarted.sessionId, intent);
      const [completed] = await db.select().from(adapterAuthSessions).where(eq(adapterAuthSessions.id, restarted.sessionId));
      expect(completed.status).toBe("authenticated");
      first = await login.start(companyId, owner, intent);
      await login.cancel(companyId, owner, first.sessionId);
      first = await login.start(companyId, owner, intent);

      expect(await reaper.sweep()).toEqual({ released: 0, failed: 0, deferred: 0 });
    }
    await login.cancel(companyId, owner, first.sessionId);
    expect(await reaper.sweep()).toEqual({ released: 0, failed: 0, deferred: 0 });
    expect(releaseById).not.toHaveBeenCalled();
    expect(await createDbSetupTokenCleanupStore(db).listReapable(Date.now())).toEqual([]);
  }, 60000);

  it("clears a terminal Claude record that has no lease and holds a record with a failing lease", async () => {
    const store = createDbSetupTokenCleanupStore(db);
    const [environment] = await db.select().from(environments).limit(1);
    const base = {
      companyId, ownerUserId: owner, adapterType: "claude_local", environmentId: environment!.id,
      deadline: Date.now() + 60_000, state: "failed" as const, boundAt: null,
    };
    const leaseless = { ...base, sessionId: randomUUID(), leaseId: "" };
    const failing = { ...base, sessionId: randomUUID(), leaseId: randomUUID() };
    await store.record(leaseless);
    await db.update(adapterAuthSessions).set({ providerLeaseId: null }).where(eq(adapterAuthSessions.publicSessionId, leaseless.sessionId));
    await store.record(failing);

    const lines: string[] = [];
    const reaper = sweepWith(async (leaseId) => {
      if (leaseId === "") throw new Error("empty lease id");
      throw new Error("sandbox driver unreachable");
    }, lines);
    expect(await reaper.sweep()).toEqual({ released: 1, failed: 1, deferred: 0 });
    expect(await reaper.sweep()).toEqual({ released: 0, failed: 0, deferred: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("sandbox driver unreachable");
    const rows = await db.select().from(adapterAuthSessions).where(eq(adapterAuthSessions.adapterType, "claude_local"));
    expect(rows.filter((row) => row.publicSessionId === leaseless.sessionId)).toHaveLength(0);
    expect(rows.filter((row) => row.publicSessionId === failing.sessionId)).toHaveLength(1);
    await db.delete(adapterAuthSessions).where(eq(adapterAuthSessions.publicSessionId, failing.sessionId));
  });
});
