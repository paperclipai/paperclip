import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { agentRunWritesRevoked } from "../agent-run-cancellation.js";
import { loadAgentRunAuthentication } from "../middleware/agent-run-authentication.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent run authentication projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
  const identityContextId = randomUUID();
  const input = { companyId, agentId, runId };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-run-authentication-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Authentication fixture", issuePrefix: "AUTH" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running",
      activeIdentityContextId: identityContextId, responsibleUserId: "fixture-user" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function baseline() {
    const [row] = await db.select({
      activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
      responsibleUserId: heartbeatRuns.responsibleUserId,
      status: heartbeatRuns.status,
      resultJson: heartbeatRuns.resultJson,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    return row;
  }

  function contract(row: Awaited<ReturnType<typeof baseline>>) {
    return {
      activeIdentityContextId: row.activeIdentityContextId,
      responsibleUserId: row.responsibleUserId,
      status: row.status,
      writesRevoked: agentRunWritesRevoked(row),
      conversation: row.contextSnapshot?.conversationMode === true,
    };
  }

  it("preserves cancellation and conversation decisions for legacy JSON shapes", async () => {
    const results = [null, "null", "false", "42", '"requested"', "[]", "{}",
      '{"executionCancellation":null}', '{"executionCancellation":true}',
      '{"executionCancellation":"requested"}', '{"executionCancellation":[]}',
      '{"executionCancellation":{"state":"requested"}}',
      '{"executionCancellation":{"state":"completed"}}',
      '{"executionCancellation":{"state":true}}',
      '{"executionCancellation":{"state":["requested"]}}'];
    const contexts = [null, "null", '"true"', "[]", "{}", '{"conversationMode":true}',
      '{"conversationMode":false}', '{"conversationMode":"true"}', '{"conversationMode":1}'];
    for (const status of ["running", "cancelled"]) {
      for (const result of results) {
        for (const context of contexts) {
          await db.$client.unsafe("UPDATE heartbeat_runs SET status=$1, result_json=$2::jsonb, context_snapshot=$3::jsonb WHERE id=$4",
            [status, result, context, runId]);
          const [row] = await loadAgentRunAuthentication(db, input);
          expect(contract(row), JSON.stringify({ status, result, context })).toEqual(contract(await baseline()));
        }
      }
    }
  });

  it("omits large unused payloads and reads new cancellation state on every request", async () => {
    const payload = randomBytes(72 * 1024).toString("base64");
    await db.update(heartbeatRuns).set({ status: "running", resultJson: { summary: payload },
      contextSnapshot: { prompt: payload, conversationMode: true } }).where(eq(heartbeatRuns.id, runId));
    const [row] = await loadAgentRunAuthentication(db, input);
    expect(contract(row)).toEqual(contract(await baseline()));
    expect(row.resultJson).toEqual({ executionCancellation: { state: null } });
    expect(row.contextSnapshot).toEqual({ conversationMode: true });
    expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(512);
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } })
      .where(eq(heartbeatRuns.id, runId));
    expect(agentRunWritesRevoked((await loadAgentRunAuthentication(db, input))[0])).toBe(true);
  });

  it("does not return another company, agent, or run", async () => {
    for (const key of ["companyId", "agentId", "runId"] as const) {
      expect(await loadAgentRunAuthentication(db, { ...input, [key]: randomUUID() })).toEqual([]);
    }
  });
});
