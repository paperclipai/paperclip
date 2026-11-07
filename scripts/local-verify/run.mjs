import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { selectionHash } from "../ci/test-selection-manifest.mjs";
import { protocolVersion } from "./inputs.mjs";

export const cacheDirectory = root => path.join(root, ".turbo/local-verify");
const planHash = plan => createHash("sha256").update(JSON.stringify(plan)).digest("hex");

export function readPass(root, key) {
  try {
    const result = JSON.parse(readFileSync(path.join(cacheDirectory(root), `${key}.json`), "utf8"));
    return result.version === protocolVersion && result.key === key && result.status === "passed" && result.planHash === planHash(result.plan)
      && ["selected", "full"].includes(result.plan?.kind) && Array.isArray(result.plan.jobs) ? result : null;
  } catch { return null; }
}

export function readPlan(root, key) {
  try {
    const result = JSON.parse(readFileSync(path.join(cacheDirectory(root), `plan-${key}.json`), "utf8"));
    return result.version === protocolVersion && result.key === key && result.status === "planned" && result.planHash === planHash(result.plan)
      && result.plan?.kind === "selected" && Array.isArray(result.plan.jobs) ? result.plan : null;
  } catch { return null; }
}

export function mayReuseAttempt(root, key) {
  try {
    const result = JSON.parse(readFileSync(path.join(cacheDirectory(root), `attempt-${key}.json`), "utf8"));
    return result.version === protocolVersion && result.key === key && result.status === "passed";
  } catch (error) { return error.code === "ENOENT"; }
}

export function writeRecord(root, name, record) {
  const directory = cacheDirectory(root);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `${name}.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify({ ...record, planHash: planHash(record.plan) }, null, 2), { mode: 0o600 });
  renameSync(temporary, path.join(directory, `${name}.json`));
}

export const invalidatePass = (root, key) => rmSync(path.join(cacheDirectory(root), `${key}.json`), { force: true });

async function execute(command, args, root, env, label) {
  return new Promise(resolve => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit", detached: grouped });
    let stopped;
    let finished = false;
    const interrupt = signal => {
      stopped = signal;
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const onInterrupt = () => interrupt("SIGINT"), onTerminate = () => interrupt("SIGTERM");
    process.on("SIGINT", onInterrupt); process.on("SIGTERM", onTerminate);
    const finish = code => {
      if (finished) return;
      finished = true;
      process.off("SIGINT", onInterrupt); process.off("SIGTERM", onTerminate);
      resolve(stopped ? stopped === "SIGINT" ? 130 : 143 : code);
    };
    child.once("error", error => { console.error(error.message); finish(1); });
    child.once("close", code => finish(code ?? 1));
    console.log(`[verify] Running ${label}`);
  });
}

export async function runPlan(root, env, plan) {
  const directory = cacheDirectory(root);
  mkdirSync(directory, { recursive: true });
  const manifestFile = path.join(directory, `selection-${randomUUID()}.json`);
  if (plan.manifest) writeFileSync(manifestFile, JSON.stringify(plan.manifest));
  try {
    for (const job of plan.jobs) {
      const code = job.args === null ? await execute("pnpm", ["test:run"], root, env, job.id)
        : await execute(process.execPath, [path.join(root, "scripts/run-vitest-stable.mjs"), ...job.args], root,
          job.selected ? { ...env, PAPERCLIP_CI_TEST_SELECTION: manifestFile,
            PAPERCLIP_CI_SELECTION_HASH: selectionHash(plan.manifest) } : env, job.id);
      if (code !== 0) return code;
    }
    return 0;
  } finally { rmSync(manifestFile, { force: true }); }
}
