#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { comparison, localEnvironment, protocolVersion, requestKey, snapshot } from "./local-verify/inputs.mjs";
import { planVerification } from "./local-verify/plan.mjs";
import { invalidatePass, mayReuseAttempt, readPass, readPlan, runPlan, writeRecord } from "./local-verify/run.mjs";

function describe(plan, cached) {
  console.log(`[verify] ${plan.kind === "full" ? "Full Vitest suite" : plan.kind === "broad" ? "Broader verification required"
    : `${plan.selectedFiles.length}${plan.totalFiles === undefined ? "" : `/${plan.totalFiles}`} Vitest test files selected`}${cached ? "; reusing a passing local result" : ""}`);
  if (plan.reason) console.log(`[verify] ${plan.reason}`);
  if (plan.retainedFiles) console.log(`[verify] ${plan.retainedFiles} test files retained conservatively`);
  if (plan.requiredCI.length) console.log(`[verify] Required CI coverage: ${plan.requiredCI.join(", ")}`);
  console.log("[verify] Local Vitest coverage does not replace required CI, typecheck/build, browser, release, or platform-specific checks.");
}

// A change to packages/shared/src, the plugin SDK source, or an SDK build input must
// refresh the committed SDK public input pins, or every SDK-dependent Runner suite
// fails in CI. The check reads only the working tree, so report it before selection.
const sdkPublicInputs = "tests/runner-e2e/source-sdk-public-inputs.mjs";
async function staleSdkPublicInputPins(root, changed) {
  const module = path.join(root, sdkPublicInputs);
  if (!existsSync(module)) return null;
  const { isSdkPublicInput, staleSdkPublicInputsInWorkingTree, staleSdkPublicInputsMessage } = await import(pathToFileURL(module).href);
  const pins = ["tests/runner-e2e/source-sdk-public-inputs.json", "tests/runner-e2e/report-lock.json"];
  if (!changed.some(file => isSdkPublicInput(file) || pins.includes(file))) return null;
  const stale = await staleSdkPublicInputsInWorkingTree(root);
  return stale.length ? staleSdkPublicInputsMessage(stale) : null;
}

export async function verify({ root = process.cwd(), base, full = false, explain = false, noCache = false, env = localEnvironment() } = {}) {
  root = realpathSync(root);
  const before = snapshot(root, env), diff = comparison(root, base), key = requestKey(before, diff, full);
  const canReuse = !noCache && before.cacheable && mayReuseAttempt(root, key);
  const cached = canReuse ? readPass(root, key) : null;
  console.log(`[verify] Base ${diff.base.slice(0, 12)}; ${diff.changed.length} changed paths, including local edits`);
  const staleSdkPins = await staleSdkPublicInputPins(root, diff.changed);
  if (staleSdkPins) {
    console.error(`[verify] ${staleSdkPins}`);
    return 1;
  }
  if (cached) {
    if (snapshot(root, env).hash !== before.hash) throw new Error("Inputs changed during cache lookup. Run verification again.");
    describe(cached.plan, true);
    console.log(`[verify] Passed result from ${cached.completedAt}; input fingerprint ${before.hash.slice(0, 12)}`);
    if (explain) console.log(JSON.stringify({ ...diff, inputFingerprint: before.hash, cacheable: before.cacheable, plan: cached.plan }, null, 2));
    return 0;
  }
  if (!explain) {
    invalidatePass(root, key);
    writeRecord(root, `attempt-${key}`, { version: protocolVersion, key, status: "running", plan: null });
  }
  const plan = (canReuse ? readPlan(root, key) : null)
    ?? await planVerification({ root, env, diff, full });
  if (plan.manifest) plan.manifest.head = diff.head;
  if (snapshot(root, env).hash !== before.hash) throw new Error("Inputs changed during selection. Run verification again.");
  describe(plan, false);
  if (explain) {
    console.log(JSON.stringify({ ...diff, inputFingerprint: before.hash, cacheable: before.cacheable, plan }, null, 2));
    return plan.kind === "broad" ? 2 : 0;
  }
  if (plan.kind === "broad") {
    console.log("[verify] Run focused checks and use required CI for broad coverage, or explicitly run pnpm verify --full.");
    writeRecord(root, `attempt-${key}`, { version: protocolVersion, key, status: "broad", plan });
    return 2;
  }
  if (before.cacheable && !noCache && plan.kind === "selected") {
    writeRecord(root, `plan-${key}`, { version: protocolVersion, key, status: "planned", plan });
  }
  invalidatePass(root, key);
  const startedAt = new Date().toISOString();
  let code = 0;
  for (const job of plan.jobs) {
    const jobKey = createHash("sha256").update(`${key}\0${job.id}`).digest("hex");
    if (canReuse && job.cacheable && readPass(root, jobKey)) {
      console.log(`[verify] Reusing passed ${job.id}`);
      continue;
    }
    invalidatePass(root, jobKey);
    code = await runPlan(root, env, { ...plan, jobs: [job] });
    if (snapshot(root, env).hash !== before.hash) {
      console.error("[verify] Inputs changed during verification. The result cannot be reused.");
      code ||= 1;
    }
    if (code !== 0) break;
    if (!noCache && before.cacheable && job.cacheable) writeRecord(root, jobKey, {
      version: protocolVersion, key: jobKey, status: "passed", plan, jobId: job.id, completedAt: new Date().toISOString(),
    });
  }
  const after = snapshot(root, env);
  if (after.hash !== before.hash) {
    console.error("[verify] Inputs changed during verification. The result cannot be reused.");
    code ||= 1;
  }
  const record = { version: protocolVersion, key, status: code === 0 ? "passed" : "failed", startedAt,
    completedAt: new Date().toISOString(), head: diff.head, inputFingerprint: before.hash, plan, exitCode: code };
  writeRecord(root, "last-run", record);
  writeRecord(root, `attempt-${key}`, record);
  if (code === 0 && !noCache && before.cacheable && after.cacheable && plan.jobs.every(job => job.cacheable)) writeRecord(root, key, record);
  console.log(`[verify] ${code === 0 ? "Local Vitest verification passed" : "Verification failed or interrupted"}${code === 0 && !before.cacheable ? "; external inputs disable pass reuse" : ""}`);
  return code;
}

async function main() {
  const { values } = parseArgs({ options: { base: { type: "string" }, full: { type: "boolean" },
    explain: { type: "boolean" }, "no-cache": { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("Usage: pnpm verify [--base REF] [--explain] [--full] [--no-cache]\nRuns affected local Vitest checks. Exit 2 means broader coverage is required; use CI or --full.");
    return;
  }
  process.exitCode = await verify({ base: values.base, full: values.full, explain: values.explain, noCache: values["no-cache"] });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[verify] ${error.message}`); process.exitCode = 1; });
}
