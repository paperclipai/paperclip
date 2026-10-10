import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Leave three minutes for onboarding inside Playwright's existing five-minute
// startup deadline. This budget includes every install attempt and backoff.
export const INSTALL_BUDGET_MS = 120_000;
const MAX_INSTALL_ATTEMPTS = 3;
const STDERR_TAIL_CHARS = 64 * 1024;

function run(command, args, { env, signal, captureStderr = false }) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, {
      env, detached: grouped, stdio: ["ignore", "inherit", captureStderr ? "pipe" : "inherit"],
    });
    let stderr = "";
    let stopping;
    const kill = (kind) => {
      try {
        if (grouped) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const stop = () => {
      if (stopping || !child.pid) return;
      kill("SIGTERM");
      // Also stop any lifecycle-script children even if npm exits first.
      stopping = new Promise((done) => setTimeout(() => { kill("SIGKILL"); done(); }, 500));
    };
    signal.addEventListener("abort", stop, { once: true });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    });
    child.on("error", reject);
    child.on("close", async (code, exitSignal) => {
      signal.removeEventListener("abort", stop);
      await stopping;
      if (signal.aborted) reject(signal.reason);
      else resolve({ code, signal: exitSignal, stderr });
    });
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

export async function startPublishedCanary({
  version, workspace, dataDir, env = process.env,
  installBudgetMs = INSTALL_BUDGET_MS, retryDelayMs = 10_000,
  signal = new AbortController().signal,
}) {
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("An exact published Paperclip version is required");
  }
  let prefix;
  try {
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(new Error("Canary npm installation exceeded its startup budget")), installBudgetMs);
    const installSignal = AbortSignal.any([signal, budget.signal]);
    try {
      for (let attempt = 1; attempt <= MAX_INSTALL_ATTEMPTS; attempt++) {
        installSignal.throwIfAborted();
        // Every attempt gets a clean prefix. The fresh per-smoke npm cache still
        // retains downloaded tarballs, but --prefer-online refreshes metadata.
        prefix = await mkdtemp(path.join(workspace, "npm-install-"));
        const result = await run(process.platform === "win32" ? "npm.cmd" : "npm", [
          "install", "--prefix", prefix, "--no-save", "--no-package-lock", "--no-audit", "--no-fund",
          ...(attempt > 1 ? ["--prefer-online"] : []), `paperclipai@${version}`,
        ], { env, signal: installSignal, captureStderr: true });
        if (result.code === 0) break;
        const codes = [...result.stderr.matchAll(/^npm (?:error|ERR!) code ([A-Z0-9_]+)\r?$/gm)];
        const missingVersion = codes.at(-1)?.[1] === "ETARGET";
        if (!missingVersion || result.signal || attempt === MAX_INSTALL_ATTEMPTS) {
          throw new Error(`Canary npm installation failed (exit ${result.code ?? result.signal}); onboarding was not started`);
        }
        await rm(prefix, { recursive: true, force: true });
        prefix = undefined;
        process.stderr.write(`Canary dependency publication is incomplete; retrying npm installation (${attempt}/${MAX_INSTALL_ATTEMPTS})\n`);
        await delay(retryDelayMs * attempt, installSignal);
      }
    } finally {
      clearTimeout(timer);
    }
    signal.throwIfAborted();
    // Start the installed CLI exactly once. Its own failures must never trigger
    // another onboarding run or another dependency-install attempt.
    const result = await run(path.join(prefix, "node_modules", ".bin", process.platform === "win32" ? "paperclipai.cmd" : "paperclipai"),
      ["onboard", "--yes", "--data-dir", dataDir], { env, signal });
    if (result.code !== 0) throw new Error(`Canary onboarding failed (exit ${result.code ?? result.signal})`);
  } finally {
    if (prefix) await rm(prefix, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, workspace, dataDir] = process.argv.slice(2);
  const cancellation = new AbortController();
  const stop = (kind) => cancellation.abort(new Error(`Canary startup stopped by ${kind}`));
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    await startPublishedCanary({ version, workspace, dataDir, signal: cancellation.signal });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
