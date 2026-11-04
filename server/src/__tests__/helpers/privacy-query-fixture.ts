import { randomBytes, randomUUID } from "node:crypto";
import { companies, type Db } from "@paperclipai/db";

export type PrivacyPlan = Record<string, any>;
export function recursiveIssueWork(plan: PrivacyPlan) {
  let recursiveNodes = 0, inspectedRows = 0, projectProbes = 0;
  function walk(node: PrivacyPlan, recursive = false) {
    if (node["Node Type"] === "Recursive Union") {
      recursiveNodes++;
      for (const child of (node.Plans ?? []).slice(1)) walk(child, true);
      return;
    }
    const visits = (Number(node["Actual Rows"] ?? 0) + Number(node["Rows Removed by Filter"] ?? 0)) * Number(node["Actual Loops"] ?? 0);
    if (recursive && node["Relation Name"] === "issues") inspectedRows += visits;
    if (recursive && node["Relation Name"] === "projects") projectProbes += Number(node["Actual Loops"] ?? 0);
    for (const child of node.Plans ?? []) walk(child, recursive);
  }
  walk(plan);
  return { recursiveNodes, inspectedRows, projectProbes };
}

export async function seedPrivacyFixture(db: Db, input: { name: string; count: number; participated: number; history: number; comments: number; payloadBytes?: number; decoyHistory?: number; graph?: "deep" | "fanout" | "cycle" }) {
  const companyId = randomUUID(), userId = `privacy-${randomUUID()}`;
  const ids = Array.from({ length: input.count }, () => randomUUID());
  const payload = randomBytes(Math.ceil((input.payloadBytes ?? 4096) * 3 / 4)).toString("base64");
  await db.insert(companies).values({ id: companyId, name: `Synthetic ${input.name}`, issuePrefix: `P${companyId.slice(0, 7)}` });
  await db.$client.unsafe(`insert into issues(id,company_id,title,status,created_by_user_id,created_at,updated_at,visibility)
    select id,$2::uuid,'Synthetic '||n,'todo',case when n <= $4 and n%2=0 then $3 else 'other-human' end,
      '2026-01-01'::timestamptz,'2026-01-01'::timestamptz+n*interval '1 second',$5
    from unnest($1::uuid[]) with ordinality as f(id,n)`, [ids, companyId, userId, input.participated, input.graph ? "private" : "open"]);
  if (input.graph) {
    const parents = ids.map((_, index) => input.graph === "deep" ? (index ? ids[index - 1]! : null) : input.graph === "cycle" ? ids[(index + 1) % ids.length]! : index ? ids[0]! : null);
    await db.$client.unsafe(`update issues i set privacy_parent_issue_id=f.parent from unnest($1::uuid[],$2::uuid[]) f(id,parent) where i.id=f.id`, [ids, parents]);
    await db.$client.unsafe(`insert into issue_access_grants(issue_id,subject_type,subject_id,source) values($1,'user',$2,'explicit')`, [ids[0]!, userId]);
  }
  if (input.history) await db.$client.unsafe(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,details,created_at)
    select $1::uuid,'issue',i.id::text,case when n=1 or n%10=0 then 'user' else 'agent' end,
      case when (n=1 or n%20=0) and i.id=ANY($5::uuid[]) then $4 when n=1 or n%10=0 then 'other-human' else 'synthetic-worker' end,
      'issue.updated',jsonb_build_object('padding',$2::text),'2026-01-01'::timestamptz+n*interval '1 second'
    from issues i cross join generate_series(1,$3::int)n where company_id=$1::uuid order by n,i.id`, [companyId, payload, input.history, userId, ids.slice(0, input.participated)]);
  if (input.comments) await db.$client.unsafe(`insert into issue_comments(company_id,issue_id,body,created_at)
    select $1::uuid,id,$2,'2026-01-02'::timestamptz+n*interval '1 second'
    from issues cross join generate_series(1,$3::int)n where company_id=$1::uuid order by n,id`, [companyId, payload, input.comments]);
  if (input.decoyHistory) await db.$client.unsafe(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,details,created_at)
    select $1::uuid,'heartbeat_run',gen_random_uuid()::text,'agent','synthetic-worker','heartbeat.run.created',
      jsonb_build_object('padding',left($2,256)),'2026-01-01'::timestamptz+n*interval '1 second'
    from generate_series(1,$3::int)n`, [companyId, payload, input.decoyHistory]);
  await db.$client.unsafe("ANALYZE");
  return { ...input, companyId, userId, ids, payloadBytes: Buffer.byteLength(payload), activityRows: input.count * input.history, commentRows: input.count * input.comments };
}
