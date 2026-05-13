import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase, createDb } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { bootstrapTokensService } from "./bootstrap-tokens.js";

let dbHandle: EmbeddedPostgresTestDatabase;
let db: Db;

beforeAll(async () => {
  dbHandle = await startEmbeddedPostgresTestDatabase("paperclip-bs-tokens-");
  db = createDb(dbHandle.connectionString);
});
afterAll(async () => { await dbHandle.cleanup(); });

describe("bootstrapTokensService", () => {
  it("mints a token, validates it once, then rejects replay", async () => {
    const svc = bootstrapTokensService(db);
    const minted = await svc.mint({
      agentId: "11111111-1111-1111-1111-111111111111",
      companyId: "22222222-2222-2222-2222-222222222222",
      runId: "r-1", jobUid: "job-uid-1",
      ttlSeconds: 600,
    });
    expect(minted.token).toMatch(/^bst_/);

    const v1 = await svc.validateAndConsume(minted.token);
    expect(v1.ok).toBe(true);
    if (v1.ok) {
      expect(v1.binding.runId).toBe("r-1");
      expect(v1.binding.jobUid).toBe("job-uid-1");
    }

    const v2 = await svc.validateAndConsume(minted.token);
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.reason).toBe("already_consumed");
  });

  it("rejects an expired token", async () => {
    const svc = bootstrapTokensService(db);
    const minted = await svc.mint({
      agentId: "11111111-1111-1111-1111-111111111112",
      companyId: "22222222-2222-2222-2222-222222222223",
      runId: "r-2", jobUid: "job-uid-2",
      ttlSeconds: 1,
    });
    await new Promise((r) => setTimeout(r, 1100));
    const v = await svc.validateAndConsume(minted.token);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
  });

  it("rejects an unknown token with reason=not_found", async () => {
    const svc = bootstrapTokensService(db);
    const v = await svc.validateAndConsume("bst_thisisnotreal");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("not_found");
  });

  it("under concurrent consume, exactly one caller wins", async () => {
    // The previous SELECT-then-UPDATE shape allowed both concurrent calls to
    // pass the consumed_at check and both to issue the UPDATE, returning ok:true
    // twice. With the atomic conditional UPDATE, only one caller is granted the
    // claim and the other observes already_consumed.
    const svc = bootstrapTokensService(db);
    const minted = await svc.mint({
      agentId: "11111111-1111-1111-1111-111111111113",
      companyId: "22222222-2222-2222-2222-222222222224",
      runId: "r-3", jobUid: "job-uid-3",
      ttlSeconds: 600,
    });
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () => svc.validateAndConsume(minted.token)),
    );
    const oks = results.filter((r) => r.ok);
    const consumedRejections = results.filter((r) => !r.ok && r.reason === "already_consumed");
    expect(oks.length).toBe(1);
    expect(consumedRejections.length).toBe(N - 1);
  });

  it("purges tokens whose expiry is outside the retention window", async () => {
    const svc = bootstrapTokensService(db);
    const stale = await svc.mint({
      agentId: "11111111-1111-1111-1111-111111111114",
      companyId: "22222222-2222-2222-2222-222222222225",
      runId: "r-4", jobUid: "job-uid-4",
      ttlSeconds: -8 * 24 * 60 * 60,
    });
    const fresh = await svc.mint({
      agentId: "11111111-1111-1111-1111-111111111115",
      companyId: "22222222-2222-2222-2222-222222222226",
      runId: "r-5", jobUid: "job-uid-5",
      ttlSeconds: 600,
    });

    const purged = await svc.purgeExpired({
      olderThanMs: 7 * 24 * 60 * 60 * 1000,
      now: new Date(),
    });

    expect(purged).toBeGreaterThanOrEqual(1);
    const staleResult = await svc.validateAndConsume(stale.token);
    expect(staleResult.ok).toBe(false);
    if (!staleResult.ok) expect(staleResult.reason).toBe("not_found");
    const freshResult = await svc.validateAndConsume(fresh.token);
    expect(freshResult.ok).toBe(true);
  });
});
