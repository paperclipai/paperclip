import assert from "node:assert/strict";
import { availableParallelism, loadavg } from "node:os";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createDb } from "../packages/db/src/index.js";

const host = { availableCpus: availableParallelism(), loadBefore: loadavg() };
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const urls = [process.env.TASK_PROJECTION_BASELINE_URL, process.env.TASK_PROJECTION_TREATMENT_URL];
assert.ok(urls.every(Boolean), "Set isolated baseline and treatment database URLs");
for (const value of urls) {
  const url = new URL(value!);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.match(url.pathname, /^\/task_projection_[a-z0-9_]+$/);
}
const clients = urls.map(value => createDb(value!, { maxConnections: 1 }));
const samples: number[][] = [[], []];
const noise = randomBytes(3072).toString("base64");
const count = Number(arg("count") ?? 1000);
assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 10000);
const keepAlive = setInterval(() => {}, 1000);
try {
  const records = await clients[0]!.$client.unsafe("select company_id,id from issues order by id limit 1200");
  assert.ok(records.length);
  const companyId = records[0]!.company_id;
  const issueIds = records.filter(row => row.company_id === companyId).map(row => row.id);
  for (const client of clients) await client.$client.unsafe("select 1");
  for (let round = 0; round < 7; round++) for (const arm of round % 2 ? [1, 0] : [0, 1]) {
    const client = clients[arm]!;
    const started = performance.now();
    await client.$client.unsafe("begin");
    let inserted: { id: string }[] = [];
    try {
      inserted = await client.$client.unsafe<{ id: string }[]>(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,details)
        select $1::uuid,case when n%5=0 then 'issue' else 'heartbeat_run' end,
          case when n%5=0 then ($2::text[])[1+n%array_length($2::text[],1)] else gen_random_uuid()::text end,
          'agent','index-write-benchmark','issue.updated',jsonb_build_object('noise',left($3,case when n%5=0 then 4096 else 256 end))
        from generate_series(1,$4::integer)n returning id`, [companyId, issueIds, noise, count]);
      await client.$client.unsafe("commit");
    } catch (error) {
      await client.$client.unsafe("rollback");
      throw error;
    }
    if (round >= 2) samples[arm]!.push(performance.now() - started);
    await client.$client.unsafe("delete from activity_log where id=ANY($1::uuid[])", [inserted.map(row => row.id)]);
  }
  const stats = (values: number[]) => ({ medianMs: [...values].sort((a, b) => a - b)[2], meanMs: values.reduce((sum, n) => sum + n, 0) / values.length, minMs: Math.min(...values), maxMs: Math.max(...values), samplesMs: values });
  const report = { host: { ...host, loadAfter: loadavg() }, rowsPerTransaction: count, warmupsPerArm: 2, samplesPerArm: 5, commitIncluded: true, cleanupOutsideTiming: true, baseline: stats(samples[0]!), treatment: stats(samples[1]!) };
  if (arg("output")) await fs.writeFile(arg("output")!, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearInterval(keepAlive);
  for (const client of clients) await client.$client.end({ timeout: 0 });
}
