import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "accounting-mutations-"));
const targets = { deduplication: "deduplicates a retried receipt", company: "isolates company reporting", projection: "conserves agent projections", threshold: "stops at the exact budget boundary" };
const evidence = [];
try {
  for (const name of ["baseline", ...Object.keys(targets)]) {
    const report = path.join(directory, `${name}.json`);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "server/vitest.accounting-mutations.config.ts", "--reporter=json", `--outputFile=${report}`], {
        cwd: root, env: { ...process.env, PAPERCLIP_ACCOUNTING_MUTATION: name === "baseline" ? "" : name }, stdio: ["ignore", "pipe", "pipe"],
      });
      let log = ""; const capture = data => { log += data; };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      child.once("error", reject); child.once("exit", code => resolve({ code, log }));
    });
    const json = JSON.parse(await readFile(report, "utf8").catch(() => { throw new Error(`${name} produced no test evidence: ${result.log}`); }));
    const assertions = json.testResults.flatMap(file => file.assertionResults);
    if (name === "baseline") {
      if (result.code !== 0 || assertions.length !== 4 || assertions.some(test => test.status !== "passed")) throw new Error(`Mutation baseline failed or skipped: ${result.log}`);
    } else {
      const sentinel = assertions.find(test => test.title === targets[name]);
      if (result.code === 0 || !result.log.includes(`ACCOUNTING_MUTATION_APPLIED ${name}`) || sentinel?.status !== "failed") throw new Error(`Mutation ${name} survived or failed without its sentinel: ${result.log}`);
    }
    evidence.push({ mutation: name, result: name === "baseline" ? "passed" : "killed", assertions: assertions.map(({ title, status }) => ({ title, status })) });
    process.stdout.write(`${name}: ${name === "baseline" ? "passed" : "killed by expected assertion"}\n`);
  }
  await mkdir(path.join(root, "coverage/accounting"), { recursive: true });
  await writeFile(path.join(root, "coverage/accounting/mutations.json"), JSON.stringify({ generatedAt: new Date().toISOString(), evidence }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
