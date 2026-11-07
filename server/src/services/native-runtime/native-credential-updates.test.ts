import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { appendNativeCredentialUpdate } from "./native-credential-updates.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
const runnerInstanceId = randomUUID(), normalizedSessionId = randomUUID();
const event: PrpEvent = {
  schema: "paperclip.prp.event.v3", schemaVersion: 3, eventType: "auth.credentials.updated",
  sourceKind: "runner", sourceInstanceId: runnerInstanceId, sourceEventId: "credential_update_1", sourceSeq: 9,
  runId, normalizedSessionId, priority: 0, emittedAt: "2026-10-15T19:00:00.000Z",
  payload: { schema: "paperclip.auth.credentials.updated.v1", provider: "codex",
    bindingId: "harness-auth", revision: 1, detection: "credential_store" },
};
const binding = { companyId, agentId, runnerInstanceId, normalizedSessionId };
beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("paperclip-credential-updates-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Credential delivery", issuePrefix: "CRED" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Observer", adapterType: "codex_local" });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", runtimeMode: "native",
    nativeSessionId: normalizedSessionId, runnerInstanceId });
}, 60_000);
afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

it("persists idle updates idempotently without colliding with normalized events", async () => {
  await appendHeartbeatRunEvent(db, { companyId, agentId, runId, eventType: "item.completed", nativeSource: {
    sourceInstanceId: runnerInstanceId, sourceEventId: "normalized-event", sourceSeq: event.sourceSeq,
    protocolSchemaVersion: 3, canonicalPayload: { normalized: true },
  } });
  await appendNativeCredentialUpdate(db, { ...binding, event });
  await appendNativeCredentialUpdate(db, { ...binding, event: structuredClone(event) });
  const rows = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.eventType === event.eventType)).toMatchObject({
    sourceInstanceId: `${runnerInstanceId}:credentials`, sourceEventId: `credentials:${event.sourceEventId}`,
    payload: { prpEvent: event },
  });
  await expect(appendNativeCredentialUpdate(db, { ...binding, event: {
    ...event, payload: { ...event.payload, revision: 2 },
  } })).rejects.toThrow("native_event_replay_conflict");
});

it.each(["companyId", "agentId", "runnerInstanceId", "normalizedSessionId"] as const)(
  "rejects credential updates outside the bound %s", async field => {
    await expect(appendNativeCredentialUpdate(db, { ...binding, [field]: randomUUID(), event }))
      .rejects.toThrow("native_credential_update_binding_mismatch");
  },
);

it("rejects unbound runs and credential payloads with secret fields", async () => {
  await expect(appendNativeCredentialUpdate(db, { ...binding, event: { ...event, runId: randomUUID() } }))
    .rejects.toThrow("native_credential_update_binding_mismatch");
  await expect(appendNativeCredentialUpdate(db, { ...binding, event: { ...event,
    payload: { ...event.payload, access_token: "synthetic-secret" },
  } })).rejects.toThrow("native_credential_update_binding_mismatch");
});
