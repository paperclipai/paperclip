import { randomUUID, createHash, generateKeyPairSync } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  agentIdentityKeys,
  type Db,
} from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { createS3StorageProvider } from "../../storage/s3-provider.js";
import { createObjectRunLogStore } from "../object-run-log-store.js";
import { createNativeRunLogExporter, formatNativeRunLogEvent } from "./native-run-log-export.js";
import { recoverSettledNativeRunLog, readRecoverableRunLog } from "./native-run-log-recovery.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { createNativeRunLogTestTables } from "../../__tests__/helpers/native-run-log-database.js";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import type { StorageProvider } from "../../storage/types.js";
import { appendNativeCredentialUpdate } from "./native-credential-updates.js";
import { appendRetainedNativeCleanupEvent } from "./native-session-executor.js";
import { idleWorkSnapshot } from "../task-admission.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { localEncryptedProvider } from "../../secrets/local-encrypted-provider.js";
import { createHeartbeatRunOutput } from "../heartbeat/run-output.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { ObjectJournalConflictError } from "../object-byte-journal.js";

const url = resolveExternalTestDatabaseUrl("PAPERCLIP_RUN_EVIDENCE_MIGRATION_DATABASE_URL");
const endpoint = process.env.PAPERCLIP_LOG_TEST_S3_ENDPOINT;
describe.skipIf(!url || !endpoint)("native run log source recovery", () => {
  const schema = `native_log_${randomUUID().replaceAll("-", "")}`,
    bucket = `pc-native-log-${randomUUID()}`;
  let db: Db,
    client: S3Client,
    bucketCreated = false;
  beforeAll(async () => {
    db = createDb(url!, { maxConnections: 1, idleTimeoutSeconds: 0 });
    await db.execute(sql.raw(`create schema ${schema}`));
    await db.execute(sql.raw(`set search_path=${schema}`));
    await createNativeRunLogTestTables(db);
    client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    bucketCreated = true;
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (client && bucketCreated) {
      for (;;) {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
        if (!page.Contents?.length) break;
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: page.Contents.map((item) => ({ Key: item.Key! })) },
          }),
        );
      }
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      client.destroy();
    }
    if (db) {
      await db.execute(sql.raw(`drop schema ${schema} cascade`));
      await db.$client.end();
    }
  });
  async function fixture() {
    const binding = {
      companyId: randomUUID(),
      runId: randomUUID(),
      agentId: randomUUID(),
      sessionId: randomUUID(),
      issueId: randomUUID(),
      sourceInstanceId: randomUUID(),
      controlPlaneSourceInstanceId: randomUUID(),
      completionContractId: randomUUID(),
      completionContractSha256: "test",
    };
    await db.execute(
      sql`insert into heartbeat_runs(id,company_id,agent_id,status) values(${binding.runId},${binding.companyId},${binding.agentId},'running')`,
    );
    const provider = createS3StorageProvider({
      endpoint,
      bucket,
      region: "us-east-1",
      forcePathStyle: true,
    });
    const store = (storage: StorageProvider = provider) =>
      createObjectRunLogStore({
        provider: storage,
        keyPrefix: "logs",
        flushMs: 30_000,
        assertWriterAuthority: async (input) => {
          await input.assertWriterAuthority?.();
        },
      });
    const begin = { companyId: binding.companyId, agentId: binding.agentId, runId: binding.runId };
    const port = new PaperclipControlPlanePort(db, binding);
    const event = (seq: number): PrpEvent => ({
      schema: "paperclip.prp.event.v1",
      schemaVersion: 1,
      sourceInstanceId: binding.sourceInstanceId,
      sourceEventId: `${binding.sourceInstanceId}:${seq}`,
      sourceSeq: seq,
      sourceKind: "runner",
      runId: binding.runId,
      normalizedSessionId: binding.sessionId,
      eventType: "item.delta",
      priority: 2,
      emittedAt: new Date().toISOString(),
      payload: { text: `step ${seq} 再開` },
    });
    return { binding, store, begin, port, event, provider };
  }
  it("replays acknowledged native records into a new writer, repairs gaps, and ignores late duplicates", async () => {
    const f = await fixture(),
      a = f.store(),
      h = await a.begin(f.begin);
    await db.execute(
      sql`update heartbeat_runs set log_store='s3_segments', log_ref=${h.logRef} where id=${f.binding.runId}`,
    );
    const events = [f.event(1), f.event(2), f.event(3)];
    const cursors = await Promise.all(events.slice(0, 2).map((event) => f.port.appendEvent(event)));
    const receipt = await a.enqueue!(h, {
      stream: "stdout",
      chunk: formatNativeRunLogEvent(events[0]!),
      ts: "then",
      seq: 1,
      sourceCursor: cursors[0]!.cursor,
    });
    await a.flush!(h);
    await receipt.committed;
    const b = f.store(),
      successor = await b.begin(f.begin);
    let seq = successor.initialSequence!;
    const exporter = createNativeRunLogExporter({
      db,
      companyId: f.binding.companyId,
      runId: f.binding.runId,
      afterCursor: successor.initialSourceCursor!,
      enqueue: async (sourceCursor, chunk) => {
        const queued = await b.enqueue!(successor, {
          stream: "stdout",
          chunk,
          ts: "now",
          seq: ++seq,
          sourceCursor,
        });
        void queued.committed.catch(() => undefined);
      },
      flush: () => b.flush!(successor),
    });
    const third = await f.port.appendEvent(events[2]!);
    await exporter.record(third.cursor, formatNativeRunLogEvent(events[2]!));
    await exporter.record(cursors[0]!.cursor, formatNativeRunLogEvent(events[0]!));
    await b.finalize(successor);
    const entries = (await b.read(successor)).content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(JSON.parse(line).chunk).event);
    expect(entries.map((event) => event.sourceSeq)).toEqual([1, 2, 3]);
    expect(
      await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, f.binding.runId)),
    ).toHaveLength(3);
  });
  it("repairs a settled run on demand after its controller lease expires, without extending source retention", async () => {
    const f = await fixture(),
      a = f.store(),
      h = await a.begin(f.begin);
    await f.port.appendEvent(f.event(1));
    await db.execute(
      sql`update heartbeat_runs set status='succeeded', log_store='s3_segments', log_ref=${h.logRef} where id=${f.binding.runId}`,
    );
    await db.execute(
      sql`insert into native_run_finalizations values(${f.binding.runId},${f.binding.companyId},now()+interval '1 minute')`,
    );
    const b = f.store();
    await recoverSettledNativeRunLog(db, b, h.logRef, async () => ({ enabled: false }));
    expect((await b.read(h)).content).toBe("");
    await db.execute(
      sql`update native_run_finalizations set lease_expires_at=now()-interval '1 second' where run_id=${f.binding.runId}`,
    );
    await Promise.all(
      [1, 2].map(() =>
        recoverSettledNativeRunLog(db, b, h.logRef, async () => ({ enabled: false })),
      ),
    );
    expect((await b.read(h)).content.trim().split("\n")).toHaveLength(1);
    const [run] = await db
      .select({ bytes: heartbeatRuns.logBytes })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.binding.runId));
    expect(run!.bytes).toBeGreaterThan(0);
  });
  it.each(["hash", "payload", "identity"])(
    "rejects a corrupt canonical source %s without marking the partial archive complete",
    async (kind) => {
      const f = await fixture(),
        a = f.store(),
        h = await a.begin(f.begin);
      await f.port.appendEvent(f.event(1));
      if (kind === "hash")
        await db.execute(
          sql`update heartbeat_run_events set source_payload_sha256='wrong' where run_id=${f.binding.runId}`,
        );
      else if (kind === "payload")
        await db.execute(
          sql`update heartbeat_run_events set payload='{}'::jsonb where run_id=${f.binding.runId}`,
        );
      else
        await db.execute(
          sql`update heartbeat_run_events set source_instance_id='wrong' where run_id=${f.binding.runId}`,
        );
      await db.execute(
        sql`update heartbeat_runs set status='succeeded', log_store='s3_segments', log_ref=${h.logRef} where id=${f.binding.runId}`,
      );
      await expect(
        recoverSettledNativeRunLog(db, f.store(), h.logRef, async () => ({ enabled: false })),
      ).rejects.toThrow("integrity");
      const [run] = await db
        .select({ bytes: heartbeatRuns.logBytes })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, f.binding.runId));
      expect(run!.bytes).toBeNull();
    },
  );
  it("ignores credential and retained cleanup projections when replaying canonical log sources", async () => {
    const f = await fixture(),
      a = f.store(),
      h = await a.begin(f.begin);
    await f.port.appendEvent(f.event(1));
    const credential = (sourceSeq: number): PrpEvent => ({
      ...f.event(sourceSeq),
      schema: "paperclip.prp.event.v3",
      schemaVersion: 3,
      priority: 0,
      eventType: "auth.credentials.updated",
      payload: {
        schema: "paperclip.auth.credentials.updated.v1",
        provider: "codex",
        bindingId: "test-auth",
        revision: 1,
        detection: "credential_store",
      },
    });
    await f.port.appendEvent(credential(2));
    await db.execute(sql`update heartbeat_runs set status='succeeded', log_store='s3_segments', log_ref=${h.logRef},
      native_session_id=${f.binding.sessionId}, runner_instance_id=${f.binding.sourceInstanceId} where id=${f.binding.runId}`);
    await appendNativeCredentialUpdate(db, {
      companyId: f.binding.companyId,
      agentId: f.binding.agentId,
      normalizedSessionId: f.binding.sessionId,
      runnerInstanceId: f.binding.sourceInstanceId,
      event: credential(20),
    });
    await appendRetainedNativeCleanupEvent(db, {
      companyId: f.binding.companyId,
      agentId: f.binding.agentId,
      runId: f.binding.runId,
      nativeSessionId: f.binding.sessionId,
      runnerInstanceId: f.binding.sourceInstanceId,
      requestId: "test-cleanup",
      event: f.event(21),
    });
    await appendHeartbeatRunEvent(db, {
      companyId: f.binding.companyId,
      agentId: f.binding.agentId,
      runId: f.binding.runId,
      eventType: "workspace.diff.recorded",
      payload: { complete: true },
      nativeSource: {
        sourceInstanceId: "provider-trace-reproject:test",
        sourceEventId: "provider-trace-reproject:test:change",
        sourceSeq: 1,
        protocolSchemaVersion: 1,
        canonicalPayload: { complete: true },
      },
    });
    const b = f.store();
    await recoverSettledNativeRunLog(db, b, h.logRef, async () => ({ enabled: false }));
    const entries = (await b.read(h)).content.trim().split("\n");
    expect(entries).toHaveLength(2);
    expect(JSON.parse(JSON.parse(entries[0]!).chunk).event.sourceSeq).toBe(1);
    expect(JSON.parse(JSON.parse(entries[1]!).chunk).event.eventType).toBe(
      "auth.credentials.updated",
    );
    const [run] = await db
      .select({ bytes: heartbeatRuns.logBytes })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.binding.runId));
    expect(run!.bytes).toBeGreaterThan(0);
  });
  it("aborts in-flight archive writes when its last reader cancels, then resumes without loss", async () => {
    const f = await fixture(),
      a = f.store(),
      h = await a.begin(f.begin),
      baseline = idleWorkSnapshot().active;
    await f.port.appendEvent(f.event(1));
    await db.execute(
      sql`update heartbeat_runs set status='succeeded', log_store='s3_segments', log_ref=${h.logRef} where id=${f.binding.runId}`,
    );
    let entered = false,
      aborted = false;
    const blocked: StorageProvider = {
      ...f.provider,
      async putObjectConditional(input) {
        if (input.objectKey.includes("/objects/")) {
          entered = true;
          await new Promise<void>((_resolve, reject) =>
            input.signal!.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(input.signal!.reason);
              },
              { once: true },
            ),
          );
        }
        return f.provider.putObjectConditional!(input);
      },
    };
    const controller = new AbortController();
    const repairing = recoverSettledNativeRunLog(
      db,
      f.store(blocked),
      h.logRef,
      async () => ({ enabled: false }),
      controller.signal,
    );
    const rejected = expect(repairing).rejects.toThrow("reader cancelled");
    const lastReader = new AbortController();
    const joined = recoverSettledNativeRunLog(
      db,
      f.store(blocked),
      h.logRef,
      async () => ({ enabled: false }),
      lastReader.signal,
    );
    const joinedRejected = expect(joined).rejects.toThrow("last reader cancelled");
    await vi.waitFor(() => expect(entered).toBe(true));
    controller.abort(new Error("reader cancelled"));
    await rejected;
    expect(aborted).toBe(false);
    lastReader.abort(new Error("last reader cancelled"));
    await joinedRejected;
    await vi.waitFor(() => {
      expect(aborted).toBe(true);
      expect(idleWorkSnapshot().active).toBe(baseline);
    });
    const b = f.store();
    await vi.waitFor(async () => {
      await recoverSettledNativeRunLog(db, b, h.logRef, async () => ({ enabled: false }));
    });
    expect((await b.read(h)).content.trim().split("\n")).toHaveLength(1);
  });
  it("redacts the existing agent identity and registered secrets before publishing recovered native output", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "e".repeat(64));
    const f = await fixture();
    const keys = generateKeyPairSync("ed25519"),
      privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const keyId = `sha256:${createHash("sha256")
      .update(keys.publicKey.export({ type: "spki", format: "der" }))
      .digest("base64url")}`;
    const encrypted = await localEncryptedProvider.createSecret({ value: privateKeyPem });
    await db.insert(agentIdentityKeys).values({
      agentId: f.binding.agentId,
      companyId: f.binding.companyId,
      algorithm: "Ed25519",
      keyId,
      publicKeyPem,
      privateKeyMaterial: encrypted.material,
    });
    const secret = "registered-native-fixture-secret";
    const redactor = createAgentIdentityRedactor(privateKeyPem);
    redactor.values.push(secret);
    const run = {
      id: f.binding.runId,
      companyId: f.binding.companyId,
      agentId: f.binding.agentId,
      status: "running",
      runtimeMode: "native",
      logStore: null,
      logRef: null,
      logBytes: null,
      lastOutputSeq: 0,
      lastOutputAt: null,
    } as typeof heartbeatRuns.$inferSelect;
    const output = createHeartbeatRunOutput(db, {
      run,
      runId: run.id,
      issueId: null,
      runLogStore: f.store(),
      identityRedactor: redactor,
      secretKeys: new Set(),
      runtimeLogSecretValues: [secret],
      appendRunEvent: async () => undefined,
      getCurrentUserRedactionOptions: async () => ({ enabled: false }),
    });
    await output.begin(run);
    const h = output.handle!;
    await f.port.appendEvent({ ...f.event(1), payload: { text: `${privateKeyPem}\n${secret}` } });
    await db.execute(
      sql`update heartbeat_runs set status='succeeded', log_store='s3_segments',log_ref=${h.logRef} where id=${f.binding.runId}`,
    );
    const b = f.store();
    await recoverSettledNativeRunLog(db, b, h.logRef, async () => ({ enabled: false }));
    const content = (await b.read(h)).content;
    expect(content).not.toContain(privateKeyPem.split("\n")[1]!);
    expect(content).not.toContain(secret);
    expect(content).toContain("REDACTED");
    const [snapshot] = await db
      .select({ context: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.binding.runId));
    expect(JSON.stringify(snapshot!.context)).not.toContain(privateKeyPem.split("\n")[1]!);
  });
  it("serves the published snapshot when another writer wins a repair claim", async () => {
    const f = await fixture(),
      a = f.store(),
      h = await a.begin(f.begin);
    const event = f.event(1),
      receipt = await f.port.appendEvent(event);
    const queued = await a.enqueue!(h, {
      stream: "stdout",
      chunk: formatNativeRunLogEvent(event),
      ts: "then",
      seq: 1,
      sourceCursor: receipt.cursor,
    });
    await a.flush!(h);
    await queued.committed;
    await f.port.appendEvent(f.event(2));
    await db.execute(
      sql`update heartbeat_runs set status='succeeded',log_store='s3_segments',log_ref=${h.logRef} where id=${f.binding.runId}`,
    );
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
    const store = {
      ...f.store(),
      async begin() {
        enter();
        await blocked;
        throw new ObjectJournalConflictError();
      },
    };
    const repairing = recoverSettledNativeRunLog(db, store, h.logRef, async () => ({
      enabled: false,
    }));
    const rejected = expect(repairing).rejects.toBeInstanceOf(ObjectJournalConflictError);
    await entered;
    const read = readRecoverableRunLog(db, store, h);
    release();
    await rejected;
    expect((await read).content.trim().split("\n")).toHaveLength(1);
    await a.finalize(h);
  });
});
