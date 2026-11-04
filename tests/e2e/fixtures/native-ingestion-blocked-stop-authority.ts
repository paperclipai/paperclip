// Bounded verbatim copy of the H5c authority/process proof, e431ec63; frozen measured source stays unchanged.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
export async function runtimeAuthority(input: {
  appRoot: string; companyId: string; environmentId: string; issueIds: string[]; transport: "local" | "sandbox-remote";
  afterStop?: boolean; recordedFailureRunIds?: string[];
}) {
  const configuration = process.env.PAPERCLIP_E2E_SERVER_CONFIG;
  if (!configuration) throw new Error("Missing owned server configuration");
  const config = JSON.parse(await readFile(configuration, "utf8"));
  expect(config.database.mode).toBe("embedded-postgres");
  const dataDirectory = await realpath(config.database.embeddedPostgresDataDir);
  const ownedHome = await realpath(path.resolve(path.dirname(configuration), "../.."));
  expect(dataDirectory.startsWith(`${ownedHome}${path.sep}`)).toBe(true);
  const owner = (await readFile(path.join(dataDirectory, "postmaster.pid"), "utf8")).split(/\r?\n/);
  expect(await realpath(owner[1])).toBe(dataDirectory);
  const port = Number(owner[3]);
  expect(Number.isSafeInteger(port) && port > 0 && port <= 65535).toBe(true);
  const require = createRequire(path.join(input.appRoot, "packages/db/package.json"));
  const postgres = require("postgres");
  const sql = postgres({ host: "127.0.0.1", port, database: "paperclip", username: "paperclip", password: "paperclip",
    max: 1, connect_timeout: 10, connection: { application_name: "native_ingestion_remote_authority_proof" } });
  let proof;
  try {
    proof = await sql.begin("isolation level repeatable read read only", async (tx: any) => {
      const settings = await tx`select current_setting('transaction_read_only') as read_only,
        current_setting('transaction_isolation') as isolation`;
      expect(settings[0].read_only).toBe("on");
      expect(settings[0].isolation).toBe("repeatable read");
      if (input.recordedFailureRunIds) {
        const queryStartedAtMs = Date.now();
        const rows = await tx`select r.id as run_id, r.company_id, r.agent_id, r.runtime_mode, r.status, r.native_phase,
          r.error_code as current_error_code, r.error is not null as current_has_error,
          jsonb_typeof(r.result_json->'recoveredExecutionFailure') as recovered_type,
          r.result_json->'recoveredExecutionFailure'->>'schema' as recovered_schema,
          r.result_json->'recoveredExecutionFailure'->>'errorCode' as recovered_error_code,
          r.result_json->'recoveredExecutionFailure'->>'observedAt' as recovered_observed_at,
          f.attempt as finalization_attempt
          from heartbeat_runs r left join native_run_finalizations f on f.run_id = r.id and f.company_id = r.company_id
          where r.company_id = ${input.companyId} and r.id = any(${input.recordedFailureRunIds}::uuid[])`;
        return { kind: "recorded-run-failure-codes", queryStartedAtMs, checkedAtMs: Date.now(),
          transaction: "READ ONLY REPEATABLE READ", observedReadOnly: settings[0].read_only,
          observedIsolation: settings[0].isolation, rows };
      }
      const rows = await tx`select r.id as run_id, r.company_id, r.agent_id, r.native_issue_id as issue_id, r.runtime_mode,
        r.native_session_id, r.runner_instance_id, r.status, r.process_pid, r.process_group_id, r.process_started_at,
        r.runner_profile_json->'nativeExecutionInput'->'binding'->>'executionWorkspaceId' as admitted_execution_workspace_id,
        r.result_json->'nativeCancellation'->>'dispatchState' as cancellation_dispatch_state,
        i.seq as process_identity_seq, i.payload as process_identity, i.source_event_id as process_identity_source_event_id,
        s.seq as process_stopped_seq, s.payload as process_stopped, s.source_event_id as process_stopped_source_event_id,
        l.id as lease_id, l.environment_id, l.provider, l.provider_lease_id,
        c.part as checkpoint_part, octet_length(c.material::text) as checkpoint_header_bytes
        from heartbeat_runs r
        join environment_leases l on l.heartbeat_run_id = r.id and l.company_id = r.company_id
        left join native_runner_checkpoints c on c.run_id = r.id and c.company_id = r.company_id
          and c.issue_id = r.native_issue_id and c.part = 'header'
        left join lateral (select seq, payload, source_event_id from heartbeat_run_events e where e.run_id = r.id
          and e.company_id = r.company_id and e.event_type = 'native.process_identity_recorded'
          and e.source_event_id is null order by seq desc limit 1) i on true
        left join lateral (select seq, payload, source_event_id from heartbeat_run_events e where e.run_id = r.id
          and e.company_id = r.company_id and e.event_type = 'native.local_process_stopped'
          and e.source_event_id is null order by seq desc limit 1) s on true
        where r.company_id = ${input.companyId} and r.native_issue_id = any(${input.issueIds}::uuid[])`;
      expect(rows).toHaveLength(input.issueIds.length);
      expect(new Set(rows.map((row: any) => row.issue_id)).size).toBe(input.issueIds.length);
      for (const row of rows) {
        expect(row.company_id).toBe(input.companyId);
        expect(row.runtime_mode).toBe("native");
        expect(row.environment_id).toBe(input.environmentId);
        if (input.transport === "sandbox-remote") {
          expect(row.provider).toBe("fake-plugin");
          expect(row.provider_lease_id).toMatch(/^fake-plugin:\/\//);
          expect(row.checkpoint_part).toBe("header");
          expect(Number(row.checkpoint_header_bytes)).toBeGreaterThan(0);
        } else {
          expect(row.provider).toBe("local"); expect(row.provider_lease_id).toBeNull();
          expect(row.checkpoint_part, "Local raw transport keeps its existing host-file journal authority").toBeNull();
          expect(row.process_identity?.targetKind).toBe("local"); expect(row.process_identity?.hostname).toBe(hostname());
          expect(row.process_identity_source_event_id).toBeNull();
          expect(BigInt(String(row.process_identity_seq))).toBeGreaterThan(0n);
          expect(row.admitted_execution_workspace_id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
          if (row.process_started_at) expect(row.process_identity.processStartedAt).toBe(new Date(row.process_started_at).toISOString());
        }
      }
      return { kind: input.transport === "local" ? "host-file-journal" : "database-controller-checkpoint",
        checkedBeforeMeasuredEpoch: !input.afterStop, checkedAtMs: Date.now(), transaction: "READ ONLY REPEATABLE READ",
        observedReadOnly: settings[0].read_only, observedIsolation: settings[0].isolation, rows };
    });
  } finally { await sql.end({ timeout: 5 }); }
  const connectionClosedAtMs = Date.now();
  let localJournal;
  if (input.transport === "local" && !input.afterStop && !input.recordedFailureRunIds) {
    expect(input.issueIds).toHaveLength(1);
    const base = await realpath(path.join(path.dirname(configuration), "runtime/paperclip-runner/durable-sessions"));
    expect(base.startsWith(`${ownedHome}${path.sep}`)).toBe(true);
    const directories = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name));
    expect(directories.length, "Bound the owned fixture journal metadata search").toBeLessThanOrEqual(256);
    for (const directory of directories) {
      const file = path.join(base, directory.name, "control-plane/control-plane-state.json");
      const metadata = await lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null; throw error;
      });
      if (!metadata) continue;
      expect(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 16 * 1024 * 1024).toBe(true);
      expect((await realpath(file)).startsWith(`${base}${path.sep}`)).toBe(true);
      const bytes = await readFile(file), state = JSON.parse(bytes.toString("utf8"));
      if (state.identity?.runId !== proof!.rows[0].run_id) continue;
      expect(localJournal, "Exactly one owned local journal must match the actual run").toBeUndefined();
      expect(state.schema).toBe("paperclip.runner.durable.control-plane-state.v1");
      expect(state.checkpointEventPolicy).not.toBe("control-v1");
      expect(state.identity.runnerInstanceId).toBe(proof!.rows[0].runner_instance_id);
      expect(state.identity.normalizedSessionId).toBe(proof!.rows[0].native_session_id);
      expect(state.identity.environmentLeaseId).toBe(proof!.rows[0].admitted_execution_workspace_id);
      localJournal = { file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
        schema: state.schema, identity: Object.fromEntries(["runnerInstanceId", "environmentLeaseId", "runId", "normalizedSessionId", "turnId", "itemId"]
          .map(key => [key, state.identity[key]])), checkpointEventPolicy: state.checkpointEventPolicy, checkedAtMs: Date.now() };
    }
    expect(localJournal, "Missing actual owned local raw journal").toBeTruthy();
  }
  return { ...proof, connectionClosedAtMs, localJournal };
}

export const processAbsent = (pid: number) => {
  expect(Number.isSafeInteger(pid) && Math.abs(pid) > 1).toBe(true);
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
};
