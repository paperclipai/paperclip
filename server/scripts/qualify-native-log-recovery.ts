import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import { createDb, heartbeatRuns } from "@paperclipai/db";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import {
  DurablePrpControlPlane,
  decodeDurablePrpCheckpoint,
} from "../src/vendor/paperclip-runner/index.js";
import { createS3StorageProvider } from "../src/storage/s3-provider.js";
import { createObjectRunLogStore } from "../src/services/object-run-log-store.js";
import { createObjectByteJournal } from "../src/services/object-byte-journal.js";
import { createHeartbeatRunOutput } from "../src/services/heartbeat/run-output.js";
import { createAgentIdentityRedactor } from "../src/services/agent-identity-redaction.js";
import { appendHeartbeatRunEvent } from "../src/services/heartbeat-run-events.js";
import { PaperclipControlPlanePort } from "../src/services/native-runtime/paperclip-control-plane-port.js";
import { formatNativeRunLogEvent } from "../src/services/native-runtime/native-run-log-export.js";
import { createNativeRunLogTestTables } from "../src/__tests__/helpers/native-run-log-database.js";

const endpoint = process.env.PAPERCLIP_LOG_TEST_S3_ENDPOINT;
const databaseUrl = process.env.PAPERCLIP_RUN_EVIDENCE_MIGRATION_DATABASE_URL;
if (
  !endpoint ||
  !databaseUrl ||
  [endpoint, databaseUrl].some((url) => !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
)
  throw new Error("Qualification requires explicit disposable loopback S3 and Postgres endpoints");
const childMode = process.argv[2] === "--controller";
type Config = {
  schema: string;
  bucket: string;
  checkpoint: string;
  companyId: string;
  agentId: string;
  runId: string;
  sessionId: string;
  runnerInstanceId: string;
  environmentLeaseId: string;
  turnId: string;
  itemId: string;
};
const config: Config = childMode
  ? JSON.parse(await fs.readFile(process.argv[3]!, "utf8"))
  : {
      schema: `native_log_proof_${randomUUID().replaceAll("-", "")}`,
      bucket: `pc-native-proof-${randomUUID()}`,
      checkpoint: "",
      companyId: randomUUID(),
      agentId: randomUUID(),
      runId: randomUUID(),
      sessionId: randomUUID(),
      runnerInstanceId: randomUUID(),
      environmentLeaseId: randomUUID(),
      turnId: randomUUID(),
      itemId: randomUUID(),
    };
const db = createDb(databaseUrl, { maxConnections: 1, idleTimeoutSeconds: 0 });
await db.execute(sql`set client_min_messages=warning`);
const provider = createS3StorageProvider({
  endpoint,
  bucket: config.bucket,
  region: "us-east-1",
  forcePathStyle: true,
});
const logStore = () =>
  createObjectRunLogStore({
    provider,
    keyPrefix: "logs",
    flushMs: 30_000,
    assertWriterAuthority: async (input) => {
      await input.assertWriterAuthority?.();
    },
  });
const identity = {
  runnerInstanceId: config.runnerInstanceId,
  environmentLeaseId: config.environmentLeaseId,
  runId: config.runId,
  normalizedSessionId: config.sessionId,
  turnId: config.turnId,
  itemId: config.itemId,
};
const expectedRunnerVersion = "0.3.0",
  expectedRunnerDigest = `sha256:${"c".repeat(64)}`;
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (done(value)) return value;
    await delay(40);
  }
  throw new Error("Native log qualification deadline exceeded");
}
if (childMode) {
  const home = process.argv[4]!,
    portNumber = Number(process.argv[5] || 0);
  await db.execute(sql.raw(`set search_path=${config.schema}`));
  if (portNumber) {
    const records = new Map<string, string>(
      JSON.parse(await fs.readFile(config.checkpoint, "utf8")),
    );
    decodeDurablePrpCheckpoint(records).restoreSessionDirectory(home);
  }
  const store = logStore();
  const [row] = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      runtimeMode: heartbeatRuns.runtimeMode,
      logStore: heartbeatRuns.logStore,
      logRef: heartbeatRuns.logRef,
      logBytes: heartbeatRuns.logBytes,
      lastOutputSeq: heartbeatRuns.lastOutputSeq,
      lastOutputAt: heartbeatRuns.lastOutputAt,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, config.runId));
  type Run = typeof heartbeatRuns.$inferSelect;
  const output = createHeartbeatRunOutput(db, {
    run: row as Run,
    runId: config.runId,
    issueId: null,
    runLogStore: store,
    identityRedactor: createAgentIdentityRedactor(),
    secretKeys: new Set(),
    getCurrentUserRedactionOptions: async () => ({ enabled: false }),
    appendRunEvent: async (_run, event) => {
      await appendHeartbeatRunEvent(db, {
        companyId: config.companyId,
        agentId: config.agentId,
        runId: config.runId,
        ...event,
      });
    },
    assertWriterAuthority: async () => {
      const [current] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, config.runId));
      if (current?.status !== "running") throw new Error("fixture_writer_revoked");
    },
  });
  const handlers = await output.begin(row as Run);
  const record = async (event: Parameters<typeof formatNativeRunLogEvent>[0], cursor: number) => {
    await handlers.onPersistedNativeLog!(cursor, formatNativeRunLogEvent(event));
  };
  const persistence = new PaperclipControlPlanePort(
    db,
    {
      ...config,
      issueId: randomUUID(),
      sourceInstanceId: config.runnerInstanceId,
      controlPlaneSourceInstanceId: `control-${config.runId}`,
      completionContractId: randomUUID(),
      completionContractSha256: "qualification",
    },
    { onCommittedEvent: record, onDuplicateEvent: record },
  );
  const core = new DurablePrpControlPlane({
    stateDirectory: path.join(home, "control-plane"),
    identity,
    expectedRunnerVersion,
    expectedRunnerDigest,
    onCommittedEvent: async (event) => {
      await persistence.appendEvent(event);
    },
  });
  core.setCheckpointPersistence(async (checkpoint) => {
    const temporary = `${config.checkpoint}.pending`;
    await fs.writeFile(temporary, JSON.stringify([...checkpoint.records]));
    await fs.rename(temporary, config.checkpoint);
  });
  await core.start(portNumber || undefined);
  const ticket = core.issueBootstrapTicket();
  await core.flushCheckpoint();
  process.on("message", async (message: { id: string; type: string }) => {
    try {
      if (message.type === "checkpoint") await core.flushCheckpoint();
      else if (message.type === "finish-log") {
        const result = await store.finalize(output.handle!);
        await output.flushOutputProgress({ force: true });
        if (result.bytes === null) throw new Error("qualification_log_incomplete");
      } else {
        core.queueCommand(message.type, {}, message.id, true);
        await waitFor(
          async () => core.getCommand(message.id)?.status,
          (status) => status === "completed",
        );
      }
      process.send!({ id: message.id, ok: true });
    } catch (error) {
      process.send!({ id: message.id, error: String(error) });
    }
  });
  process.send!({ ready: true, connectUrl: core.connectUrl, ticket });
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-log-qualification-"));
  config.checkpoint = path.join(root, "checkpoint.json");
  const configFile = path.join(root, "config.json"),
    receiptFile = path.join(root, "receipt.json"),
    releaseFile = path.join(root, "release"),
    scriptFile = path.join(root, "script.json");
  const children: ChildProcess[] = [];
  const client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true });
  let bucketCreated = false;
  async function controller(home: string, portNumber = 0) {
    await fs.mkdir(home, { mode: 0o700 });
    const child = spawn(
      process.execPath,
      [
        "--import",
        path.resolve("server/node_modules/tsx/dist/loader.mjs"),
        fileURLToPath(import.meta.url),
        "--controller",
        configFile,
        home,
        String(portNumber),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PAPERCLIP_HOME: home },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    children.push(child);
    let diagnostics = "";
    child.stderr!.on("data", (bytes) => {
      diagnostics = (diagnostics + String(bytes)).slice(-8000);
    });
    const ready = await new Promise<{ connectUrl: string; ticket: string }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Controller startup timeout: ${diagnostics}`)),
        45_000,
      );
      child.on("message", (message: { ready?: boolean; connectUrl: string; ticket: string }) => {
        if (message.ready) {
          clearTimeout(timeout);
          resolve(message);
        }
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error(`Controller startup failed: ${diagnostics}`));
      });
    });
    async function command(type: string) {
      const id = randomUUID();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.off("message", onMessage);
          reject(new Error(`Command timeout: ${type}: ${diagnostics}`));
        }, 35_000);
        function onMessage(message: { id: string; error?: string }) {
          if (message.id !== id) return;
          clearTimeout(timer);
          child.off("message", onMessage);
          message.error ? reject(new Error(message.error)) : resolve();
        }
        child.on("message", onMessage);
        child.send({ id, type });
      });
    }
    return { child, ready, command };
  }
  try {
    await db.execute(sql.raw(`create schema ${config.schema}`));
    await db.execute(sql.raw(`set search_path=${config.schema}`));
    await createNativeRunLogTestTables(db);
    await db.execute(
      sql`insert into heartbeat_runs(id,company_id,agent_id,status) values(${config.runId},${config.companyId},${config.agentId},'running')`,
    );
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
    bucketCreated = true;
    await fs.writeFile(configFile, JSON.stringify(config));
    await fs.writeFile(
      scriptFile,
      JSON.stringify({ steps: 64, waitAfter: 32, retentionLimit: 8, receiptFile, releaseFile }),
    );
    const homeA = path.join(root, "web-a"),
      a = await controller(homeA);
    const runner = spawn(
      path.resolve("packages/paperclip-runner/runner/target/debug/examples/recovery-fixture"),
      [
        "--fixture-script",
        scriptFile,
        "--connect-url",
        a.ready.connectUrl,
        "--state-dir",
        path.join(root, "runner"),
        "--runner-id",
        config.runnerInstanceId,
        "--environment-lease-id",
        config.environmentLeaseId,
        "--run-id",
        config.runId,
        "--session-id",
        config.sessionId,
        "--turn-id",
        config.turnId,
        "--item-id",
        config.itemId,
        "--runner-version",
        expectedRunnerVersion,
        "--runner-digest",
        expectedRunnerDigest,
        "--max-outbox-bytes",
        "65536",
        "--p0-reserve-bytes",
        "16384",
        "--reconnect-grace-ms",
        "60000",
      ],
      {
        env: { ...process.env, PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: a.ready.ticket },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    children.push(runner);
    let runnerDiagnostics = "";
    runner.stderr!.on("data", (bytes) => {
      runnerDiagnostics = (runnerDiagnostics + String(bytes)).slice(-4000);
    });
    const receipt = async () =>
      JSON.parse(await fs.readFile(receiptFile, "utf8").catch(() => "{}")) as {
        pid: number;
        acknowledgedEvents: number;
        completedSteps: number;
        retainedEvents: number;
        peakRetainedEvents: number;
      };
    await a.command("turn.start");
    await fs.writeFile(releaseFile, "go");
    const acknowledged = await waitFor(
      receipt,
      (value) => value.acknowledgedEvents === 32 && value.retainedEvents === 0,
    );
    const journal = createObjectByteJournal({
      provider,
      prefix: `logs/segments-v1/${config.companyId}/${config.agentId}/${config.runId}`,
    });
    const before = (await journal.head())!.head;
    assert(
      before.sourceCursor < 32,
      "Experiment must kill a controller with acknowledged output still pending in S3",
    );
    const controlStarted = performance.now();
    await a.command("session.snapshot");
    const controlMs = performance.now() - controlStarted;
    await a.command("checkpoint");
    const exitA = once(a.child, "exit");
    a.child.kill("SIGKILL");
    await exitA;
    await fs.rm(homeA, { recursive: true });
    const b = await controller(path.join(root, "web-b"), Number(new URL(a.ready.connectUrl).port));
    await b.command("turn.steer");
    const completed = await waitFor(
      receipt,
      (value) => value.acknowledgedEvents === 64 && value.retainedEvents === 0,
    );
    assert.equal(completed.pid, acknowledged.pid);
    assert.equal(runner.exitCode, null, runnerDiagnostics);
    const stopStarted = performance.now();
    await b.command("turn.stop");
    const stopMs = performance.now() - stopStarted;
    await b.command("finish-log");
    const store = logStore(),
      content = (
        await store.read({
          store: "s3_segments",
          logRef: `${config.companyId}/${config.agentId}/${config.runId}`,
        })
      ).content;
    const events = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(JSON.parse(line).chunk).event);
    assert.deepEqual(
      events.map((event) => Number(event.payload.text.match(/^step=(\d+)/)[1])),
      Array.from({ length: 64 }, (_, index) => index + 1),
    );
    assert.equal(new Set(events.map((event) => event.sourceEventId)).size, 64);
    const [source] = await db.execute(
      sql`select count(*)::int as count from heartbeat_run_events where run_id=${config.runId}`,
    );
    assert.equal(source!.count, 64);
    const shutdown = once(runner, "exit");
    await b.command("runner.shutdown");
    assert.equal((await shutdown)[0], 0);
    process.stdout.write(
      `${JSON.stringify({
        result: "passed",
        source: "real Rust recovery fixture and PaperclipControlPlanePort",
        acknowledgedBeforeKill: 32,
        objectSourceCursorBeforeKill: before.sourceCursor,
        controllerLoss: "SIGKILL",
        oldDirectoryRemoved: true,
        sameRunnerProcess: true,
        recoveredRecords: events.length,
        duplicates: 0,
        existingControlRows: source!.count,
        controlCommandMs: Math.round(controlMs),
        stopMs: Math.round(stopMs),
        peakRunnerRetained: completed.peakRetainedEvents,
      })}\n`,
    );
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
    if (bucketCreated) {
      for (;;) {
        const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket }));
        if (!page.Contents?.length) break;
        await client.send(
          new DeleteObjectsCommand({
            Bucket: config.bucket,
            Delete: { Objects: page.Contents.map((object) => ({ Key: object.Key! })) },
          }),
        );
      }
      await client.send(new DeleteBucketCommand({ Bucket: config.bucket }));
    }
    client.destroy();
    await db.execute(sql.raw(`drop schema if exists ${config.schema} cascade`));
    await db.$client.end();
    await fs.rm(root, { recursive: true, force: true });
  }
}
