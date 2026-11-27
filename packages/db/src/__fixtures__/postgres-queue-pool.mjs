import { createRequire } from "node:module";

const queries = Number(process.env.QUERIES ?? 20_000);
const connections = Number(process.env.CONNECTIONS ?? 24);
const concurrency = Number(process.env.CONCURRENCY ?? 8);
const windows = Number(process.env.WINDOWS ?? 4);
const measured = process.env.MEASURE_SCANS !== "0";

const scans = { max: 0 };
const indexOf = Array.prototype.indexOf;
if (measured) {
  Array.prototype.indexOf = function (item, from) {
    if (item && typeof item === "object" && "idleTimer" in item && "execute" in item) {
      scans.max = Math.max(scans.max, this.length - Math.max(0, from ?? 0));
    }
    return indexOf.call(this, item, from);
  };
}

const postgres = process.env.DRIVER_FORMAT === "cjs"
  ? createRequire(import.meta.url)("postgres")
  : (await import("postgres")).default;
const sql = postgres(process.env.TEST_DATABASE_URL, {
  max: connections,
  idle_timeout: 0,
  max_lifetime: 0,
  connection: { application_name: "driver-queue-pool" },
  onnotice() {},
});

try {
  await Promise.all(Array.from({ length: connections }, () => sql`select pg_sleep(0.05)`));
  const [{ count }] = await sql`select count(*)::int as count from pg_stat_activity where application_name = 'driver-queue-pool'`;
  if (count !== connections) throw new Error(`expected ${connections} open connections, found ${count}`);

  const perWindow = Math.floor(queries / windows);
  const results = [];
  for (let window = 0; window < windows; window++) {
    scans.max = 0;
    let remaining = perWindow;
    const cpu = process.cpuUsage();
    const started = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (remaining-- > 0) {
        const [row] = await sql`select 1 as value`;
        if (row.value !== 1) throw new Error("unexpected result");
      }
    }));
    const used = process.cpuUsage(cpu);
    results.push({
      cpuMicrosPerQuery: Number(((used.user + used.system) / perWindow).toFixed(2)),
      wallMicrosPerQuery: Number((((performance.now() - started) * 1000) / perWindow).toFixed(2)),
      maxScan: scans.max,
    });
  }
  console.log(JSON.stringify({ queries: perWindow * windows, connections, concurrency, windows: results }));
} finally {
  Array.prototype.indexOf = indexOf;
  await sql.end({ timeout: 1 });
}
