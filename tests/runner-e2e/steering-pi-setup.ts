import { spawn, type ChildProcess } from "node:child_process";
import { open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPiSetupEnvironment } from "../../cli/src/commands/runtime.js";
import { PRIVATE_OPERATION_STATE, newPreframeworkOperation, sealPreframeworkOperation } from "./manual-private-operation.js";
import { CREDENTIAL_NAMES } from "./types.js";
import { readManualPrivateHandoff } from "./manual-private-handoff.js";
import { boundedOwnedFile, digest, assertSteeringPiTargetSource, STEERING_PI_PROFILE, STEERING_PI_SOURCE_CLOSURE, requireSteeringPiTime, steeringPiAssetIdentity, STEERING_PI_EXECUTION, STEERING_PI_JOB_MS, STEERING_PI_RECEIPT, type SteeringPiReceipt } from "./steering-pi-receipt.js";

const DRAIN_MS = 310_000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
export function steeringPiJob(value: unknown, env: NodeJS.ProcessEnv, now: number) {
  const page = value as { total_count?: number; jobs?: Record<string, unknown>[] };
  if (!Array.isArray(page.jobs) || page.total_count !== page.jobs.length || page.jobs.length > 100) throw new Error("Incomplete own-attempt jobs metadata");
  const matching = page.jobs.filter(job => job.run_id === Number(env.GITHUB_RUN_ID) && job.head_sha === env.GITHUB_SHA
    && job.name === STEERING_PI_EXECUTION && job.runner_name === env.RUNNER_NAME && job.workflow_name === "Runner Full-Stack E2E"
    && job.status === "in_progress" && job.completed_at === null);
  if (matching.length !== 1 || !env.RUNNER_NAME || env.GITHUB_RUN_ATTEMPT !== "1") throw new Error("Ambiguous current steering job");
  const job = matching[0]!, start = typeof job.started_at === "string" ? Date.parse(job.started_at) : NaN;
  if (!Number.isSafeInteger(job.id) || Number(job.id) <= 0 || !Number.isSafeInteger(start) || start > now || job.run_attempt !== undefined && job.run_attempt !== 1)
    throw new Error("Invalid current steering job clock");
  const deadline = start + STEERING_PI_JOB_MS;
  requireSteeringPiTime(deadline, now);
  const installMs = Math.min(900_000, deadline - now - 810_000 - DRAIN_MS);
  if (installMs <= 0) throw new Error("Insufficient installation and child-drain time");
  return { jobId: Number(job.id), runnerName: env.RUNNER_NAME, jobStartedAt: job.started_at as string, jobDeadlineMs: deadline, installMs };
}
export async function readSteeringPiJob(env: NodeJS.ProcessEnv) {
  if (env.GITHUB_REPOSITORY !== "paperclipai/paperclip" || env.GITHUB_SERVER_URL !== "https://github.com"
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") || env.GITHUB_RUN_ATTEMPT !== "1" || !env.GH_TOKEN) throw new Error("Invalid own-run metadata authority");
  const response = await fetch(`https://api.github.com/repos/paperclipai/paperclip/actions/runs/${env.GITHUB_RUN_ID}/attempts/1/jobs?per_page=100`, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(15_000), redirect: "error",
  });
  if (!response.ok || response.headers.get("link") || Number(response.headers.get("content-length") ?? 0) > 1024 * 1024 || !response.body) {
    await response.body?.cancel(); throw new Error("Own-run metadata is unavailable");
  }
  const chunks: Uint8Array[] = []; let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length;
      if (bytes > 1024 * 1024) throw new Error("Own-run metadata exceeds its allowance"); chunks.push(part.value); }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return steeringPiJob(JSON.parse(Buffer.concat(chunks).toString()), env, Date.now());
}
interface InstallerPorts {
  spawn: typeof spawn; signal: (pid: number, signal: NodeJS.Signals) => void;
  timer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: typeof clearTimeout;
}
const installerPorts: InstallerPorts = { spawn, signal: (pid, signal) => process.kill(-pid, signal), timer: setTimeout, clear: clearTimeout };
export async function runSteeringPiInstaller(input: { entry: string; cwd: string; env: NodeJS.ProcessEnv; installMs: number; write: (stream: "stdout" | "stderr", bytes: Buffer) => void; signal?: AbortSignal }, ports = installerPorts) {
  if (!Number.isSafeInteger(input.installMs) || input.installMs <= 0 || input.installMs > 900_000) throw new Error("Invalid Pi installation interval");
  input.signal?.throwIfAborted();
  const child: ChildProcess = ports.spawn(process.execPath, ["--use-env-proxy", input.entry], {
    cwd: input.cwd, env: buildPiSetupEnvironment(input.env), detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let cancelled = false, failure = false, output = 0, stdout = "", closed = false;
  let drain: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (closed || cancelled) return;
    cancelled = true;
    if (child.pid) { try { ports.signal(child.pid, "SIGTERM"); } catch { failure = true; } }
    drain = ports.timer(() => { if (!closed && child.pid) { try { ports.signal(child.pid, "SIGKILL"); } catch { failure = true; } } }, DRAIN_MS);
  };
  const deadline = ports.timer(stop, input.installMs);
  input.signal?.addEventListener("abort", stop, { once: true });
  if (input.signal?.aborted) stop();
  return await new Promise<{ status: SteeringPiReceipt["status"]; target: "linux-x64"; profileDigest: string }>((accept, reject) => {
    child.once("error", () => { failure = true; });
    for (const stream of ["stdout", "stderr"] as const) child[stream]?.on("data", (part: Buffer) => {
      output += part.length;
      if (output > OUTPUT_LIMIT) { failure = true; stop(); return; }
      try { input.write(stream, part); if (stream === "stdout") stdout += part.toString("utf8"); } catch { failure = true; stop(); }
    });
    child.once("close", (code, signal) => {
      closed = true; ports.clear(deadline); if (drain) ports.clear(drain); input.signal?.removeEventListener("abort", stop);
      if (cancelled || failure || signal || code !== 0) { reject(Object.assign(new Error("Pi installation unresolved; no assets admitted"), { outcome: cancelled ? "cancelled" : "failed", retirement: "observed-closed", outputComplete: !failure })); return; }
      try {
        const value = JSON.parse(stdout.trim());
        if (Object.keys(value).sort().join() !== "profileDigest,status,target" || !["installed_verified", "verified_existing"].includes(value.status)
          || value.target !== "linux-x64" || value.profileDigest !== STEERING_PI_PROFILE.digest) throw new Error("Invalid Pi setup result");
        accept(value);
      } catch { reject(Object.assign(new Error("Pi installation produced no accepted verification receipt"), { outcome: "failed", retirement: "observed-closed", outputComplete: true })); }
    });
  });
}
export async function prepareSteeringPi(env: NodeJS.ProcessEnv) {
  const context = await readManualPrivateHandoff(env, [STEERING_PI_EXECUTION]);
  if (!context) throw new Error("Steering Pi requires verified original build custody");
  const operation = newPreframeworkOperation(context, /^[a-f0-9]{64}$/.test(env.STEERING_PI_BUILD_SHA256 ?? "") ? env.STEERING_PI_BUILD_SHA256! : null);
  const state = await open(path.join(context.root, PRIVATE_OPERATION_STATE), "wx", 0o600);
  const save = async () => { const bytes = Buffer.from(`${JSON.stringify(operation)}\n`); let written = 0; while (written < bytes.length) { const part = await state.write(bytes, written, bytes.length - written, written); if (!part.bytesWritten) throw new Error("Pi operation state write stopped"); written += part.bytesWritten; } await state.truncate(bytes.length); await state.sync(); };
  const controller = new AbortController(), cancel = () => controller.abort();
  const outputs: Partial<Record<"stdout" | "stderr", Awaited<ReturnType<typeof open>>>> = {};
  let writeFailure: unknown; let writes = Promise.resolve(); let receiptCreated = false;
  const discardReceipt = async () => { if (receiptCreated) { await unlink(path.join(context.root, STEERING_PI_RECEIPT)); receiptCreated = false; } };
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  try {
    await save();
    if (env.STEERING_PI_RESTORED !== "success" || env.STEERING_PI_BUILD_ARTIFACT !== operation.buildArtifact || !operation.buildSha256) throw new Error("Steering Pi requires verified original build custody");
    const target = await realpath(env.GITHUB_WORKSPACE ?? "");
    if (target !== path.resolve(env.GITHUB_WORKSPACE ?? "")) throw new Error("Invalid Pi target source root");
    for (const name of ["steering-pi-receipt.ts", "steering-pi-target-source.json"]) {
      if (digest(await boundedOwnedFile(path.join(target, "tests/runner-e2e", name), 512 * 1024)) !== digest(await boundedOwnedFile(fileURLToPath(new URL(`./${name}`, import.meta.url)), 512 * 1024)))
        throw new Error("Target lacks the reviewed Pi admission reader");
    }
    await assertSteeringPiTargetSource(target);
    const packageRoot = path.join(target, "packages/paperclip-runner");
    const manifest = JSON.parse((await boundedOwnedFile(path.join(packageRoot, "package.json"), 65_536)).toString());
    if (manifest.name !== "@paperclipai/paperclip-runner") throw new Error("Invalid Pi runner package");
    const entry = path.join(packageRoot, "dist/cli/provision-pi.cjs"), provisionerSha256 = digest(await boundedOwnedFile(entry, 64 * 1024 * 1024));
    operation.provisionerSha256 = provisionerSha256;
    const job = await readSteeringPiJob(env);
    controller.signal.throwIfAborted();
    for (const stream of ["stdout", "stderr"] as const) {
      controller.signal.throwIfAborted();
      outputs[stream] = await open(path.join(context.root, `steering-pi-installer.${stream}.log`), "wx", 0o600);
      operation.capturedStreams.push(stream); await save();
    }
    controller.signal.throwIfAborted();
    operation.phase = "installer"; operation.outcome = "unknown"; operation.retirement = "unknown"; operation.outputCapture = "unknown"; await save();
    const result = await runSteeringPiInstaller({ entry, cwd: packageRoot, env, installMs: Math.min(job.installMs, job.jobDeadlineMs - Date.now() - 810_000 - DRAIN_MS), signal: controller.signal,
      write: (stream, bytes) => { writes = writes.then(async () => { await outputs[stream]!.writeFile(bytes); }).catch(error => { writeFailure = error; controller.abort(); }); },
    });
    operation.phase = "asset-verification"; operation.outcome = "failed"; operation.retirement = "observed-closed";
    await writes; if (writeFailure) throw new Error("Pi installation evidence was not retained"); operation.outputCapture = "complete"; await save();
    for (const output of Object.values(outputs)) await output!.sync();
    controller.signal.throwIfAborted();
    if (digest(await boundedOwnedFile(entry, 64 * 1024 * 1024)) !== provisionerSha256) throw new Error("Pi provisioner changed during setup");
    const assets = await steeringPiAssetIdentity(target); requireSteeringPiTime(job.jobDeadlineMs, Date.now());
    controller.signal.throwIfAborted();
    const { installMs: _installMs, ...clock } = job;
    const receipt: SteeringPiReceipt = { schema: "paperclip.steering-pi-assets/v1", executionId: STEERING_PI_EXECUTION,
      runId: context.runId, attempt: "1", workflowSha: context.workflowSha, targetSha: context.targetSha, ...clock,
      buildArtifact: operation.buildArtifact, buildSha256: operation.buildSha256, provisionerSha256, sourceClosureSha256: STEERING_PI_SOURCE_CLOSURE, ...result, ...assets };
    const file = await open(path.join(context.root, STEERING_PI_RECEIPT), "wx", 0o600); receiptCreated = true;
    try { await file.writeFile(`${JSON.stringify(receipt)}\n`); await file.sync(); } finally { await file.close(); }
    controller.signal.throwIfAborted();
  } catch (error) {
    await discardReceipt();
    const observed = error as { outcome?: string; retirement?: string; outputComplete?: boolean };
    await writes; if (operation.phase === "installer" && !writeFailure && observed.outputComplete === true) operation.outputCapture = "complete";
    if (operation.phase === "admission") operation.outcome = "failed";
    else if (observed.retirement === "observed-closed" && ["failed", "cancelled"].includes(observed.outcome ?? "")) {
      operation.retirement = "observed-closed"; operation.outcome = observed.outcome as "failed" | "cancelled";
    }
    if (controller.signal.aborted && operation.retirement !== "unknown") operation.outcome = "cancelled";
    await save(); throw error;
  } finally {
    try { await writes; for (const output of Object.values(outputs)) await output!.close(); await state.close(); controller.signal.throwIfAborted(); }
    catch (error) { await discardReceipt(); throw error; }
    finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const execute = async () => {
    if (process.argv[2] === "seal-failure") {
      const context = await readManualPrivateHandoff(process.env, [STEERING_PI_EXECUTION]); if (!context) throw new Error("Missing private failure custody");
      const secrets = [...CREDENTIAL_NAMES, "GH_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"].flatMap(key => process.env[key] ? [process.env[key]!] : []);
      await sealPreframeworkOperation(context, secrets);
    } else if (process.argv.length === 2) await prepareSteeringPi(process.env);
    else throw new Error("Invalid Pi preparation action");
  };
  execute().catch(() => { console.error("STEERING_PI_PREPARATION_STOPPED"); process.exitCode = 1; });
}
