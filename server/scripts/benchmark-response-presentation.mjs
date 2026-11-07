// Run only in a clean, isolated checkout. Reuses the real chat integration fixture.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

assert.equal(process.version, "v24.22.2", "Use Node24.22.2 for the recorded comparison");
const root = fileURLToPath(new URL("../..", import.meta.url));
const output = path.resolve(process.argv[2] ?? mkdtempSync(path.join(tmpdir(), "presentation-benchmark-")));
mkdirSync(output, { recursive: true });
assert.equal(existsSync(path.join(output, "pairs.jsonl")), false, "Use a fresh output directory");
const baseline = "82c033ed127d07862e6765aa4b69a3cf339bde81";
const integration = "server/src/__tests__/chat-channels.integration.test.ts";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
assert.equal(git("status", "--porcelain").trim(), "", "Commit fixture changes first; use an isolated checkout");
const original = readFileSync(path.join(root, integration), "utf8");
const anchor = '  it("settles a shared-endpoint accepted-response backlog';
assert.equal(original.split(anchor).length, 2, "Expected one fixture insertion point");
const files = ["query", "work"].map(kind => `server/src/services/native-runtime/native-response-presentation-${kind}.baseline.ts`);
for (const file of files) assert.equal(existsSync(path.join(root, file)), false, `Refusing to replace ${file}`);
const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
  PAPERCLIP_PRESENTATION_BENCHMARK_OUTPUT: output };
assert.equal(execFileSync("pnpm", ["--version"], { cwd: root, env, encoding: "utf8" }).trim(), "9.15.4", "Use pnpm9.15.4");
writeFileSync(path.join(output, "metadata.json"), JSON.stringify({ baseline, treatment: git("rev-parse", "HEAD").trim(),
  node: process.version, execPath: process.execPath, pairs: 5, runs: 10,
  mode: "real PostgreSQL source service under Vitest; accelerated retry timers; instrumented process CPU" }, null, 2));
const benchmark = String.raw`  it("measures equivalent completed accepted-response work without artificial sleeps", async () => {
    const { appendFileSync } = await import("node:fs");
    const output = process.env.PAPERCLIP_PRESENTATION_BENCHMARK_OUTPUT;
    if (!output) throw new Error("Benchmark output directory is required");
    const { nativeResponsePresentationWork: baselineWork } = await import("../services/native-runtime/native-response-presentation-work.baseline.js");
    const { createDatabaseResponseCapture, installDatabaseResponseCapture } = await import("@paperclipai/db/response-capture");
    const schema = await import("@paperclipai/db");
    appendFileSync(output + "/child-runtime.jsonl",
      JSON.stringify({ version: process.version, execPath: process.execPath }) + "\n");
    expect(process.version).toBe("v24.22.2");
    const fixedTime = Date.now();
    const capture = createDatabaseResponseCapture({ start: fixedTime - 1, end: fixedTime + 59_999 }, () => {}, () => fixedTime);
    let measuring = false, queries = 0, rows = 0, queryErrors = 0;
    capture.execute = (action => {
      const counted = measuring;
      if (counted) queries++;
      return Promise.resolve().then(action).then(value => {
        if (counted && Array.isArray(value)) rows += value.length;
        return value;
      }, error => { if (counted) queryErrors++; throw error; });
    }) as typeof capture.execute;
    installDatabaseResponseCapture(db, schema, capture);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      for (let round = 0; round < 5; round++) {
        for (const label of round % 2 ? ["after", "before"] : ["before", "after"]) {
          const fixture = await seedCompany();
          const configured = await configuredTelegramEndpoint(fixture);
          const contexts = [];
          for (let index = 0; index < 4; index++) contexts.push(await committedChatResponseRecoveryFixture(
            "telegram", "coordinator", false, undefined, undefined, true,
            { fixture, configured, suffix: String(311 + index) }));
          const failures: unknown[] = [];
          const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => failures.push(error) });
          queries = rows = queryErrors = 0;
          const wallStart = performance.now(), cpuStart = process.cpuUsage(), virtualStart = Date.now();
          measuring = true;
          const worker = (label === "before" ? baselineWork : nativeResponsePresentationWork)(db).register(coordinator, () => true);
          let passes = 0, observerIterations = 0;
          try {
            await worker.ready;
            for (;;) {
              while (idleWorkSnapshot().active !== 0) {
                observerIterations++;
                await new Promise(resolve => setTimeout(resolve, 1));
              }
              observerIterations++;
              const next = coordinator.nextWakeAt();
              if (next === null) break;
              if (++passes > 10) throw new Error("Response benchmark did not settle");
              await vi.advanceTimersByTimeAsync(Math.max(0, next - Date.now()) + 1);
            }
            measuring = false;
            const cpu = process.cpuUsage(cpuStart), wallMs = performance.now() - wallStart;
            for (const context of contexts) {
              const comments = await db.select().from(issueComments).where(eq(issueComments.createdByRunId, context.runId));
              expect(comments).toHaveLength(1);
              expect(comments[0].body).toBe(context.result.summary);
              const publications = await readChatPublicationsByCommentId(comments[0].id);
              expect(publications).toHaveLength(1);
              expect(publications[0]).toMatchObject({ companyId: fixture.companyId, endpointId: configured.endpoint.id,
                issueId: context.issue.id, conversationId: context.conversation.id, payload: { text: context.result.summary } });
            }
            expect(await readChatPublicationsByEndpointId(configured.endpoint.id)).toHaveLength(4);
            appendFileSync(output + "/pairs.jsonl", JSON.stringify({ round, label, node: process.version, execPath: process.execPath, observerIterations,
              wallMs, cpuMs: (cpu.user + cpu.system) / 1000, queries, rows, queryErrors,
              failedPasses: failures.length, replayedRetryDeadlines: passes,
              virtualElapsedMs: Date.now() - virtualStart, completedResponses: 4,
              artificialDatabaseSleep: false, endpointCount: 1, issueCount: 4 }) + "\n");
          } finally { measuring = false; worker.stop(); await coordinator.stop(); await configured.service.shutdown(); }
        }
      }
    } finally { measuring = false; capture.flush(); vi.useRealTimers(); }
  }, 120_000);

`;
let status = 1;
try {
  for (const [index, kind] of ["query", "work"].entries()) {
    const source = git("show", `${baseline}:server/src/services/native-runtime/native-response-presentation-${kind}.ts`);
    const materialized = kind === "work" ? source.replace("./native-response-presentation-query.js", "./native-response-presentation-query.baseline.js") : source;
    writeFileSync(path.join(root, files[index]), materialized);
    writeFileSync(path.join(output, path.basename(files[index])), materialized);
  }
  writeFileSync(path.join(output, "benchmark-fragment.txt"), benchmark);
  writeFileSync(path.join(root, integration), original.replace(anchor, benchmark + anchor));
  const log = openSync(path.join(output, "vitest.log"), "wx");
  try {
    const result = spawnSync("pnpm", ["exec", "vitest", "run", "--project", "@paperclipai/server", integration,
      "-t", "measures equivalent completed accepted-response work without artificial sleeps"],
      { cwd: root, env, stdio: ["ignore", log, log] });
    if (result.error) throw result.error;
    status = result.status ?? 1;
  } finally { closeSync(log); }
  if (status === 0) {
    const pairs = readFileSync(path.join(output, "pairs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(pairs.length, 10);
    assert.ok(pairs.every(pair => pair.node === "v24.22.2" && pair.completedResponses === 4));
  }
} finally {
  writeFileSync(path.join(root, integration), original);
  for (const file of files) rmSync(path.join(root, file), { force: true });
}
console.log(`Benchmark ${status === 0 ? "passed" : "failed"}; artifacts: ${output}`);
process.exitCode = status;
