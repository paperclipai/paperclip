import { randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { reviewedChatExecutionIds } from "./chat-runtime-profile.js";
import { DOCKER_DATABASE_ENV } from "./docker-postgres.js";

/**
 * Test-only storage fault for `inbox-search.archive-partial-failure`.
 *
 * The native runner calls the product API on the server's own loopback
 * listener, so a fault placed in front of PAPERCLIP_API_URL never sees the
 * agent's archive requests. This fault sits below every route instead: a
 * temporary trigger on the case-owned database makes the product's own archive
 * write fail with a Postgres I/O error. The trigger is scoped to one company,
 * person, agent and the three seeded tasks, fails only the write that would be
 * the third archive of that set, counts every injected failure per task in
 * non-transactional sequences, and is dropped before the declared retry. It
 * never writes or edits product rows; all saved state comes from the product.
 */
export const ARCHIVE_SCENARIO = "inbox-search.archive-partial-failure";
export interface ArchiveFaultBinding { companyId: string; agentId: string; personId: string; taskIds: string[] }
export interface ArchiveStorageFault {
  /** Injected failures per seeded task id, read from rollback-proof sequences. */
  failures(): Promise<Record<string, number>>;
  release(): Promise<void>;
  close(): Promise<void>;
}
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export function validArchiveFaultBinding(value: ArchiveFaultBinding) {
  return !!value && Object.keys(value).sort().join() === "agentId,companyId,personId,taskIds" && uuid.test(value.companyId) && uuid.test(value.agentId)
    && typeof value.personId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value.personId)
    && Array.isArray(value.taskIds) && value.taskIds.length === 3 && value.taskIds.every(id => typeof id === "string" && uuid.test(id)) && new Set(value.taskIds).size === 3;
}

/** Statements only; ids are validated above and are the only interpolated values. */
export function archiveStorageFaultSql(tag: string, binding: ArchiveFaultBinding) {
  if (!/^[a-f0-9]{12}$/.test(tag) || !validArchiveFaultBinding(binding)) throw new Error("Archive storage fault requires an exact owned binding");
  const name = `paperclip_e2e_archive_fault_${tag}`, ids = `'{${binding.taskIds.join(",")}}'::uuid[]`, lock = Number.parseInt(tag.slice(0, 7), 16);
  const sequences = binding.taskIds.map((_, index) => `${name}_hits_${index + 1}`);
  const install = [
    ...sequences.map(sequence => `create sequence ${sequence}`),
    `create function ${name}() returns trigger language plpgsql as $fault$
declare archived integer; position integer;
begin
  if NEW.company_id <> '${binding.companyId}'::uuid or NEW.user_id <> '${binding.personId}' or NEW.archived_by_actor_type <> 'agent'
    or NEW.archived_by_agent_id is distinct from '${binding.agentId}'::uuid or not (NEW.issue_id = any(${ids})) then
    return NEW;
  end if;
  -- Serialize this person's archive writes for the seeded set so parallel
  -- requests cannot all observe zero prior archives.
  perform pg_advisory_xact_lock(${lock});
  select count(*) into archived from issue_inbox_archives
    where company_id = NEW.company_id and user_id = NEW.user_id and issue_id = any(${ids}) and issue_id <> NEW.issue_id;
  if archived >= 2 then
    position := array_position(${ids}, NEW.issue_id);
    perform nextval(format('${name}_hits_%s', position)::regclass);
    raise exception 'could not write inbox archive row' using errcode = '58030';
  end if;
  return NEW;
end
$fault$`,
    `create trigger ${name} before insert or update on issue_inbox_archives for each row execute function ${name}()`,
  ];
  return {
    install,
    release: [`drop trigger if exists ${name} on issue_inbox_archives`],
    remove: [`drop trigger if exists ${name} on issue_inbox_archives`, `drop function if exists ${name}()`, ...sequences.map(sequence => `drop sequence if exists ${sequence}`)],
    failures: sequences.map(sequence => `select case when is_called then last_value else 0 end as hits from ${sequence}`),
  };
}

async function ownedDatabaseUrl(env: NodeJS.ProcessEnv) {
  const temporary = env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT, config = env.PAPERCLIP_CONFIG, home = env.PAPERCLIP_HOME, instance = env.PAPERCLIP_INSTANCE_ID;
  if (!(temporary && config && home && instance && path.isAbsolute(temporary) && path.isAbsolute(config) && path.isAbsolute(home) && /^[A-Za-z0-9_-]+$/.test(instance))) throw new Error("Archive storage fault requires the owned runner instance");
  const [root, actualConfig, actualHome] = await Promise.all([realpath(temporary), realpath(config), realpath(home)]);
  if (actualHome !== path.join(root, "paperclip-home") || actualConfig !== path.join(actualHome, "instances", instance, "config.json")) throw new Error("Archive storage fault refuses an unowned instance");
  const { assertRunnerDatabaseIsolation } = await import("./instance-isolation.js");
  const docker = env[DOCKER_DATABASE_ENV];
  await assertRunnerDatabaseIsolation(actualConfig, root, docker || undefined);
  const parsed = JSON.parse(await readFile(actualConfig, "utf8")) as { database?: { mode?: string; connectionString?: string; embeddedPostgresPort?: number } };
  const url = parsed.database?.mode === "postgres" ? parsed.database.connectionString
    : Number.isInteger(parsed.database?.embeddedPostgresPort) ? `postgres://paperclip:paperclip@127.0.0.1:${parsed.database!.embeddedPostgresPort}/paperclip` : undefined;
  if (!url) throw new Error("Archive storage fault could not resolve the owned database");
  return url;
}

export async function armArchiveStorageFault(input: { executionId: string; binding: ArchiveFaultBinding; env?: NodeJS.ProcessEnv }): Promise<ArchiveStorageFault> {
  const env = input.env ?? process.env;
  let selected: unknown; try { selected = JSON.parse(env.PAPERCLIP_RUNNER_E2E_EXECUTION_IDS ?? "null"); } catch { selected = null; }
  if (!reviewedChatExecutionIds(ARCHIVE_SCENARIO).includes(input.executionId) || !Array.isArray(selected) || selected.length !== 1 || selected[0] !== input.executionId)
    throw new Error("Archive storage fault is allowed only when its own case is the single selected execution");
  const statements = archiveStorageFaultSql(randomBytes(6).toString("hex"), input.binding);
  const { createDb } = await import("../../packages/db/src/index.js");
  const db = createDb(await ownedDatabaseUrl(env), { maxConnections: 1, connectTimeoutSeconds: 5 }), client = db.$client;
  let closed = false, released = false;
  const run = async (list: string[]) => { for (const statement of list) await client.unsafe(statement); };
  try { await client.begin(async tx => { for (const statement of statements.install) await tx.unsafe(statement); }); }
  catch (error) { await client.end({ timeout: 5 }); throw error; }
  return {
    async failures() {
      if (closed) throw new Error("Archive storage fault is closed");
      const counts: Record<string, number> = {};
      for (const [index, statement] of statements.failures.entries()) { const [row] = await client.unsafe(statement); counts[input.binding.taskIds[index]!] = Number(row?.hits ?? 0); }
      return counts;
    },
    async release() { if (closed || released) throw new Error("Archive storage fault was already released"); await run(statements.release); released = true; },
    async close() { if (closed) return; closed = true; try { await run(statements.remove); } finally { await client.end({ timeout: 5 }); } },
  };
}
