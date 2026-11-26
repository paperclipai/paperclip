import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { startEmbeddedPostgresTestDatabase } from "../src/test-embedded-postgres.js";

type Item = { queue: Queue | null };
type Queue = { readonly length: number; push(item: Item): Item; shift(): Item | undefined; remove(item: Item): Item | null };

const simulatedQueries = Number(process.env.SIMULATED_QUERIES ?? 1_000_000);
const poolQueries = Number(process.env.QUERIES ?? 200_000);
const driverRoot = path.resolve(path.dirname(createRequire(import.meta.url).resolve("postgres")), "../..");
const Queue: () => Queue = (await import(pathToFileURL(path.join(driverRoot, "src/queue.js")).href)).default;

function simulate() {
  const open = Queue();
  const busy = Queue();
  const move = (c: Item, queue: Queue) => {
    c.queue?.remove(c);
    queue.push(c);
    c.queue = queue;
  };
  for (let id = 0; id < 117; id++) move({ queue: null }, open);
  const running: Item[] = new Array(8);
  const windows: number[] = [];
  let started = performance.now();
  for (let query = 1; query <= simulatedQueries; query++) {
    const c = open.shift()!;
    move(c, busy);
    const slot = query % running.length;
    if (running[slot]) move(running[slot], open);
    running[slot] = c;
    if (query % (simulatedQueries / 5) === 0) {
      windows.push(Number((((performance.now() - started) * 1000) / (simulatedQueries / 5)).toFixed(3)));
      started = performance.now();
    }
  }
  return { queries: simulatedQueries, connections: 117, inFlight: 8, microsPerQueryByWindow: windows };
}

const temporary = process.env.DATABASE_URL ? null : await startEmbeddedPostgresTestDatabase("postgres-queue-benchmark-");
try {
  const simulation = simulate();
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../src/__fixtures__/postgres-queue-pool.mjs", import.meta.url)),
  ], {
    env: {
      ...process.env,
      TEST_DATABASE_URL: process.env.DATABASE_URL ?? temporary!.connectionString,
      QUERIES: String(poolQueries),
      WINDOWS: "10",
      MEASURE_SCANS: "0",
    },
    timeout: 600_000,
  });
  const pool = JSON.parse(stdout) as { windows: Array<{ cpuMicrosPerQuery: number; wallMicrosPerQuery: number }> };
  console.log(JSON.stringify({
    simulation,
    pool: {
      ...pool,
      windows: undefined,
      cpuMicrosPerQueryByWindow: pool.windows.map((window) => window.cpuMicrosPerQuery),
      wallMicrosPerQueryByWindow: pool.windows.map((window) => window.wallMicrosPerQuery),
    },
  }));
} finally {
  await temporary?.cleanup();
}
