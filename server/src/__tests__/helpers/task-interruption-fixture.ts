import { randomBytes, randomUUID } from "node:crypto";
import { agents, companies, issues, type Db } from "@paperclipai/db";
import type { taskInterruptionPresentations } from "../../services/task-interruption-presentation.js";

export type InterruptionReader = typeof taskInterruptionPresentations;
export type CapturedQuery = { sql: string; params: unknown[] };

export async function captureInterruptionQuery(db: Db, reader: InterruptionReader,
  companyId: string, input: Parameters<InterruptionReader>[2]) {
  let captured: CapturedQuery | undefined;
  const stop = new Error("captured interruption query");
  const captureDb = new Proxy(db, { get(target, key) {
    if (key !== "select" && key !== "selectDistinctOn") return Reflect.get(target, key);
    return (...args: unknown[]) => {
      const builder = Reflect.apply(Reflect.get(target, key), target, args);
      const from = builder.from.bind(builder);
      builder.from = (...tables: unknown[]) => {
        const selection = from(...tables);
        selection.execute = async () => {
          const query = selection.toSQL() as CapturedQuery;
          if (query.sql.includes('"heartbeat_runs"')) captured = query;
          throw stop;
        };
        return selection;
      };
      return builder;
    };
  }});
  try { await reader(captureDb, companyId, input); }
  catch (error) { if (error !== stop) throw error; }
  if (!captured) throw new Error("The real interruption caller did not issue a run query");
  return captured;
}

export async function seedInterruptionFixture(db: Db, options: {
  selected: number; history: number; unrelated: number; payloadBytes: number; preserveLegacyBindings?: boolean;
}) {
  const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values([companyId, otherCompanyId].map((id, index) => ({
    id, name: `Synthetic interruption ${index}`, issuePrefix: `I${id.slice(0, 7)}`,
  })));
  await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic agent", adapterType: "process" });
  const input = await db.insert(issues).values(Array.from({ length: options.selected }, (_, n) => ({
    companyId, title: `Synthetic task ${n}`, status: "in_progress", assigneeAgentId: agentId,
  }))).returning();
  const contextNoise = randomBytes(options.payloadBytes).toString("base64");
  const resultNoise = randomBytes(options.payloadBytes).toString("base64");
  const ids = input.map(issue => issue.id);
  if (options.preserveLegacyBindings !== false) await db.$client.unsafe("alter table heartbeat_runs disable trigger heartbeat_runs_set_scope_kind");
  await db.$client.unsafe(`insert into heartbeat_runs
    (company_id, agent_id, scope_kind, native_issue_id, issue_id, status, created_at, context_snapshot, result_json)
    select $1::uuid, $2::uuid, case when n % 3 = 1 then 'issue' else 'company' end,
      case when n % 3 = 0 then task.id end,
      case when n % 3 = 1 then task.id end,
      case when n = $4::integer then 'failed' else 'succeeded' end,
      timestamp '2026-10-27 00:00:00+00' + n * interval '1 second',
      jsonb_build_object('issueId', task.id::text, 'noise', $5::text),
      jsonb_build_object('configurationIncomplete', false, 'noise', $6::text)
    from unnest($3::uuid[]) task(id) cross join generate_series(1, $4::integer) n`,
    [companyId, agentId, ids, options.history, contextNoise, resultNoise]);
  await db.$client.unsafe(`insert into heartbeat_runs
    (company_id, agent_id, status, created_at, context_snapshot, result_json)
    select case when n % 10 = 0 then $2::uuid else $1::uuid end, $3::uuid, 'succeeded',
      timestamp '2026-10-28 00:00:00+00',
      jsonb_build_object('issueId', gen_random_uuid()::text, 'noise', $5::text),
      jsonb_build_object('noise', $6::text)
    from generate_series(1, $4::integer) n`,
    [companyId, otherCompanyId, agentId, options.unrelated, contextNoise, resultNoise]);
  if (options.preserveLegacyBindings !== false) await db.$client.unsafe("alter table heartbeat_runs enable trigger heartbeat_runs_set_scope_kind");
  await db.$client.unsafe("analyze heartbeat_runs");
  return { companyId, otherCompanyId, agentId, input };
}
