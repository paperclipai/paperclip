import { startNativeSessionExecutionLeaseRenewal } from "./native-execution-lease.js";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { checkpointDb, livenessDb, nativeRunFinalizations } from "@paperclipai/db";
import { beforeAll, expect } from "vitest";
import { createRunnerdCodexTransport, DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { registerRunnerPrpAuthority } from "../../realtime/runner-prp-ws.js";
import { nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { nativeRestartFixture, describeEmbeddedPostgres, realProcessIt, waitForCondition } from "./native-restart.test-fixture.js";

describeEmbeddedPostgres("native runner restart recovery: checkpoint-cost", () => {
  const environment = nativeRestartFixture();
  const { seedRun, transportOptions } = environment;
  let runtimeRoot: typeof environment.current.runtimeRoot;
  let companyId: typeof environment.current.companyId;
  let successor: typeof environment.current.successor;
  beforeAll(() => { ({ runtimeRoot, companyId, successor } = environment.current); });

  realProcessIt("keeps checkpoint SQL independent of streamed output volume with a real Postgres writer", async () => {
    const samples: Array<{ chunks: number; checkpointWrites: number; transactions: number;
      changedRows: number; checkpointBytes: number; walBytes: number; elapsedMs: number; idleSql: number;
      streamSql: number; streamTransactions: number; streamChangedRows: number; renewalSql: number }> = [];
    for (const chunks of [8, 512, 8192]) {
      const fixture = await seedRun(`CHECKPOINT-COST-${chunks}`);
      const root = resolve(runtimeRoot, fixture.runId);
      const releaseOutput = resolve(root, "release-output");
      const binding = { companyId, issueId: fixture.issueId, runId: fixture.runId };
      const owner = { ...binding, authorityRunId: fixture.runId, bootId: successor.bootId,
        generation: 1, leaseOwner: "cost-controller" };
      await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: owner.bootId,
        controllerPid: successor.pid, controllerProcessStartedAt: successor.processStartedAt,
        controllerGeneration: 1, leaseOwner: owner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000),
      }).where(eq(nativeRunFinalizations.runId, fixture.runId));
      let authority!: DurablePrpControlPlane;
      let measuring = false;
      let transactions = 0, changedRows = 0, checkpointBytes = 0;
      const statements: string[] = [];
      const renewalStatements: string[] = [];
      let leaseLost = false;
      const renewal = startNativeSessionExecutionLeaseRenewal({ db: fixture.db, ...binding, leaseOwner: owner.leaseOwner,
        attempt: 0, controller: successor, remote: true, onLost: async () => { leaseLost = true; } });
      const capturedClients = [fixture.db.$client, checkpointDb(fixture.db).$client, livenessDb(fixture.db).$client];
      const priorDebug = capturedClients.map(client => client.options.debug);
      // Capture statements only, never SQL parameters (encrypted state or secrets).
      capturedClients.forEach((client, index) => {
        client.options.debug = (_connection, query) => {
          if (!measuring) return;
          // Renewals are existing liveness traffic, reported separately. A
          // checkpoint query on any pool still counts against the zero oracle.
          if (index === 2 && !query.includes("native_runner_checkpoints")) renewalStatements.push(query);
          else statements.push(query);
        };
      });
      const write = nativeRunnerCheckpointWriter(fixture.db, owner);
      let costFailure: unknown;
      const transport = createRunnerdCodexTransport({ ...transportOptions(fixture, root),
        codexArgs: ["--state-file", resolve(root, "provider.json"), "--linger-after-turn-start",
          "--held-output", "--held-output-count", String(chunks), "--held-output-release-file", releaseOutput],
        controlPlaneRegistration: async core => {
          authority = core;
          core.setCheckpointPersistence(async checkpoint => {
            if (measuring) {
              transactions++;
              changedRows += checkpoint.changedRecords.size;
              checkpointBytes += [...checkpoint.changedRecords.values()].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
              expect([...checkpoint.changedRecords.values()].join("\n")).not.toContain("still computing");
            }
            await write(checkpoint);
          });
          return registerRunnerPrpAuthority({ ...binding, authority: core });
        },
      });
      try {
        await transport.transport.request("thread/start", { cwd: root, dynamicTools: [] });
        await authority.flushCheckpoint();
        const [walStart] = await fixture.db.execute(sql`select pg_current_wal_insert_lsn()::text as lsn`);
        const started = performance.now();
        measuring = true;
        await transport.transport.request("turn/start", { input: [{ type: "text", text: "Produce the scripted stream." }] });
        await waitForCondition("settled control setup before releasing text", () =>
          authority.store.state.commands.every(command => command.status === "completed")
          && authority.store.state.committedEvents.some(event => event.eventType === "turn.started"));
        await authority.flushCheckpoint();
        const beforeStream = { sql: statements.length, transactions, changedRows };
        await writeFile(releaseOutput, "release\n", { flag: "wx" });
        await waitForCondition(`the final scripted text chunk of ${chunks}`, () => authority.store.state.committedEvents
          .some(event => event.eventType === "item.delta" && JSON.stringify(event.envelope).includes(`still computing ${chunks - 1} `)), chunks > 4096 ? 480_000 : 60_000)
          .catch(error => { console.info("checkpoint-cost-stream-diagnostic", JSON.stringify({ chunks,
            cursor: authority.store.state.ackedSourceSeq,
            receivedTextEvents: authority.store.state.committedEvents.filter(event => event.eventType === "item.delta").length })); throw error; });
        await authority.flushCheckpoint();
        measuring = false;
        const elapsedMs = performance.now() - started;
        const [walEnd] = await fixture.db.execute(sql`select pg_wal_lsn_diff(pg_current_wal_insert_lsn(), ${String(walStart.lsn)}::pg_lsn)::text as bytes`);
        const checkpointWrites = statements.filter(query => /^\s*(insert|update|delete)\b/i.test(query)
          && query.includes("native_runner_checkpoints")).length;
        expect(checkpointWrites).toBeGreaterThan(0); // The collector must see real control writes.
        const snapshot = { chunks, checkpointWrites, transactions, changedRows, checkpointBytes,
          walBytes: Number(walEnd.bytes), elapsedMs, idleSql: 0, renewalSql: renewalStatements.length,
          streamSql: statements.length - beforeStream.sql,
          streamTransactions: transactions - beforeStream.transactions,
          streamChangedRows: changedRows - beforeStream.changedRows };
        // Setup control messages may coalesce differently. The released text-only
        // interval must add exactly zero work, independent of that scheduling.
        expect(snapshot).toMatchObject({ streamSql: 0, streamTransactions: 0, streamChangedRows: 0 });
        expect(leaseLost).toBe(false);
        statements.length = 0;
        measuring = true;
        await new Promise(done => setTimeout(done, 100));
        await authority.flushCheckpoint();
        snapshot.idleSql = statements.length;
        expect(statements).toEqual([]);
        // Positive calibration: an actual new control operation must trip the zero-write oracle.
        authority.queueCommand("session.snapshot", {}, `cost-positive-control-${chunks}`);
        await authority.flushCheckpoint();
        expect(statements.some(query => /insert into "native_runner_checkpoints"/i.test(query))).toBe(true);
        measuring = false;
        samples.push(snapshot);
        console.info("native-checkpoint-cost-sample", JSON.stringify(snapshot));
      } catch (error) {
        costFailure = error;
        throw error;
      } finally {
        measuring = false;
        capturedClients.forEach((client, index) => { client.options.debug = priorDebug[index]; });
        try { await transport.transport.close(); }
        catch (error) {
          if (costFailure) throw new AggregateError([costFailure, error], "Checkpoint cost measurement and cleanup failed");
          throw error;
        }
        finally {
          await renewal.stop().catch(error => {
            if (costFailure) throw new AggregateError([costFailure, error], "Checkpoint cost measurement and lease renewal failed");
            throw error;
          });
        }
      }
    }
    const report = { schema: "paperclip.checkpoint-cost/v1", samples,
      scope: "isolated Postgres; control operations included; WAL is diagnostic; no production capacity claim" };
    if (process.env.PAPERCLIP_TEST_CHECKPOINT_COST_REPORT) await writeFile(process.env.PAPERCLIP_TEST_CHECKPOINT_COST_REPORT,
      `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    // Each stream size was checked independently; total setup counts remain
    // diagnostic because control-message batching is scheduling-dependent.
    console.info("native-checkpoint-cost", JSON.stringify(report));
  }, 540_000);

});
