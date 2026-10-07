import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "accounting-mutations-"));
const artifactDirectory = path.join(root, "coverage/accounting/mutations");
const targets = { deduplication: "deduplicates a retried receipt", company: "isolates company reporting", projection: "conserves agent projections", threshold: "stops at the exact budget boundary" };
const evidence = [];
const persist = () => writeFile(path.join(root, "coverage/accounting/mutations.json"), JSON.stringify({ generatedAt: new Date().toISOString(), evidence }, null, 2));
await rm(artifactDirectory, { recursive: true, force: true });
await mkdir(artifactDirectory, { recursive: true });
try {
  for (const name of ["baseline", ...Object.keys(targets)]) {
    const report = path.join(directory, `${name}.json`);
    const entry = { mutation: name, result: "error", assertions: [] };
    evidence.push(entry);
    await persist();
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "server/vitest.accounting-mutations.config.ts", "--reporter=json", `--outputFile=${report}`], {
        cwd: root, env: { ...process.env, PAPERCLIP_ACCOUNTING_MUTATION: name === "baseline" ? "" : name }, stdio: ["ignore", "pipe", "pipe"],
      });
      let log = ""; const capture = data => { log += data; };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      child.once("error", error => resolve({ code: null, log: `${log}\n${error.message}` }));
      child.once("close", code => resolve({ code, log }));
    });
    await writeFile(path.join(artifactDirectory, `${name}.log`), result.log);
    await copyFile(report, path.join(artifactDirectory, `${name}.json`)).catch(() => {});
    const json = JSON.parse(await readFile(report, "utf8").catch(() => { throw new Error(`${name} produced no test evidence: ${result.log}`); }));
    const assertions = json.testResults.flatMap(file => file.assertionResults);
    entry.assertions = assertions.map(({ title, status, failureMessages }) => ({ title, status, failureMessages }));
    const completeRoster = assertions.length === 4 && Object.values(targets).every(title => assertions.filter(test => test.title === title).length === 1);
    if (name === "baseline") {
      entry.result = result.code === 0 && completeRoster && assertions.every(test => test.status === "passed") ? "passed" : "baseline_failed";
      if (entry.result !== "passed") throw new Error(`Mutation baseline failed or skipped: ${result.log}`);
    } else {
      const failures = assertions.filter(test => test.status === "failed");
      const sentinel = failures[0];
      // A marked AssertionError proves the intended comparison ran. Setup
      // errors, timeouts, unrelated assertions, and extra failures are invalid.
      const intendedFailure = failures.length === 1 && sentinel.title === targets[name]
        && sentinel.failureMessages?.length === 1
        && sentinel.failureMessages[0].startsWith(`AssertionError: ACCOUNTING_ASSERTION ${name}:`);
      entry.result = result.code === 1 && result.log.split(/\r?\n/).includes(`ACCOUNTING_MUTATION_APPLIED ${name}`)
        && completeRoster && assertions.every(test => test.status === "passed" || test === sentinel)
        && intendedFailure ? "killed" : "survived_or_invalid";
      if (entry.result !== "killed") throw new Error(`Mutation ${name} survived or failed without its sentinel: ${result.log}`);
    }
    await persist();
    process.stdout.write(`${name}: ${entry.result}\n`);
  }
} finally {
  // Failed baselines, surviving mutants, and missing reports are evidence too.
  try { await persist(); } finally { await rm(directory, { recursive: true, force: true }); }
}
