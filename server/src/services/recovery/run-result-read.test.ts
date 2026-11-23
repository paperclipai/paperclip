import { randomBytes, randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { isAiAuthenticationBlocked } from "../ai-auth-failure.js";
import { recoveryRunResultColumn } from "./run-result-read.js";
import { classifyAdapterFailureForRecovery, classifyContinuationFailure, recoveryService } from "./service.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("recovery result PostgreSQL projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("recovery-result-read-");
    db = createDb(database.connectionString);
    const [company] = await db.insert(companies).values({ name: "Recovery fixture", issuePrefix: "RR" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Recovery agent", adapterType: "process" }).returning();
    companyId = company.id;
    agentId = agent.id;
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function read(resultJson: unknown, errorCode: string | null = null) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", errorCode,
      resultJson: resultJson as Record<string, unknown> | null }).returning();
    const [selected] = await db.select({ resultJson: recoveryRunResultColumn }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    return { run, selected };
  }

  it("keeps typed recovery receipts without returning execution output or modifying history", async () => {
    const evidence = { errorFamily: "transient_upstream", workspaceValidation: { fingerprint: "workspace" },
      configurationIncomplete: { reason: "workspace_unavailable", fingerprint: "configuration" },
      cancelledByActorType: "board", retryNotBefore: "2099-01-01T00:00:00Z", transientRetryNotBefore: 123,
      providerQuotaRetryNotBefore: null, finalizationReasonCode: "conversation_turn_finished" };
    const payload = randomBytes(512 * 1024).toString("base64");
    const result = { ...evidence, summary: payload, output: payload, providerResponse: { output: payload } };
    const { run, selected } = await read(result);
    expect(selected.resultJson).toEqual(evidence);
    expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThan(1024);
    expect(classifyContinuationFailure({ ...run, resultJson: selected.resultJson })).toEqual(classifyContinuationFailure(run));
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(stored).toEqual(run);
  });

  it.each(["adapter_failed", "provider_quota", "configuration_incomplete"])("retains arbitrary provider evidence for %s classification", async errorCode => {
    const now = new Date("2020-01-01T00:00:00Z");
    const result = { providerSpecificField: { nestedResponse: "Rate limit exceeded. Try again after 2099-01-01T00:00:00Z" },
      configurationIncomplete: { reason: "ai_connection_unavailable" },
      output: randomBytes(64 * 1024).toString("base64") };
    const { run, selected } = await read(result, errorCode);
    expect(selected.resultJson).toEqual(result);
    const projected = { ...run, livenessState: "blocked", resultJson: selected.resultJson };
    const complete = { ...run, livenessState: "blocked" };
    expect(classifyAdapterFailureForRecovery(projected, now)).toEqual(classifyAdapterFailureForRecovery(complete, now));
    expect(classifyContinuationFailure(projected)).toEqual(classifyContinuationFailure(complete));
    expect(isAiAuthenticationBlocked(projected)).toBe(isAiAuthenticationBlocked(complete));
  });

  it("checks legacy eligibility and repair ancestry without returning large result bodies", async () => {
    const result = { output: randomBytes(512 * 1024).toString("base64") };
    const { run: source } = await read(result);
    const { run: queued } = await read(result);
    await db.update(heartbeatRuns).set({ status: "queued", contextSnapshot: {
      issueId: randomUUID(), dispositionRepairSourceRunId: source.id,
      legacyDispositionEpisode: { id: source.id, attempt: 1, maxAttempts: 2 },
    } }).where(eq(heartbeatRuns.id, queued.id));
    const reads: unknown[][] = [];
    const recorded = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const query = from(...args);
          if (args[0] === heartbeatRuns) {
            const execute = query.execute.bind(query);
            query.execute = async (...executeArgs: Parameters<typeof execute>) => {
              const rows = await execute(...executeArgs); reads.push(rows); return rows;
            };
          }
          return query;
        }) as typeof builder.from;
        return builder;
      };
    }});
    const service = recoveryService(recorded, { enqueueWakeup: async () => { throw new Error("unexpected wake"); } });
    expect(await service.reconcileLegacyContinuation(source.id)).toBe("skipped");
    expect(await service.legacyRepairDispatchBlock(queued.id)).toBe("missing_issue");
    expect(reads).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(reads))).toBeLessThan(16 * 1024);
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
    expect(stored).toEqual(source);
    const [storedQueued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id));
    expect(storedQueued.resultJson).toEqual(result);
  });

  it.each([null, [], ["unexpected"], "scalar", 42, false, {}, { errorFamily: false, cancelledByActorType: 3,
    workspaceValidation: [], configurationIncomplete: null, retryNotBefore: { invalid: true }, finalizationReasonCode: "" }]
    .map(result => ({ result })))("preserves structured evidence types for $result", async ({ result }) => {
    const { run, selected } = await read(result);
    const expected = result && typeof result === "object" && !Array.isArray(result) ? result : result === null ? null : {};
    expect(selected.resultJson).toEqual(expected);
    expect(classifyContinuationFailure({ ...run, resultJson: selected.resultJson })).toEqual(classifyContinuationFailure(run));
  });
});
