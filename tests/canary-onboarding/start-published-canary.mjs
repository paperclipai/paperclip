import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleaseManifest } from "../../scripts/release-package-map.mjs";

// Leave three minutes for onboarding inside Playwright's existing five-minute
// startup deadline. This budget includes every install attempt and backoff.
export const INSTALL_BUDGET_MS = 120_000;
const MAX_INSTALL_ATTEMPTS = 3;
const STDERR_TAIL_CHARS = 64 * 1024;
export const TARBALL_METADATA_TIMEOUT_MS = 5_000;
const METADATA_LIMIT_BYTES = 64 * 1024;
const PRIMARY_REGISTRY = "https://registry.npmjs.org/";
const RELEASE_PACKAGE_NAMES = new Set(loadReleaseManifest()
  .filter((entry) => entry.publishFromCi === true).map((entry) => entry.name));

function withAbort(pending, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const finish = (settle) => (value) => {
      signal.removeEventListener("abort", abort);
      settle(value);
    };
    // Keep handlers on the original operation even after the bounded wait
    // ends. A transport need not settle immediately when its signal aborts.
    Promise.resolve(pending).then(finish(resolve), finish(reject));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function canRetryPublishedTarball404(stderr, version, {
  signal, prefix, env = process.env, fetchMetadata = globalThis.fetch, runConfig = run,
}) {
  // A package metadata 404, a third-party artifact, or another release must not
  // be mistaken for availability of this canary's announced public tarball.
  if (!/^\d+\.\d+\.\d+-canary\.\d+$/.test(version)) return false;
  const codes = [...stderr.matchAll(/^npm (?:error|ERR!) code ([A-Z0-9_]+)\r?$/gm)];
  const final = codes.at(-1);
  if (codes.length !== 1 || final?.[1] !== "E404") return false;
  const block = stderr.slice(final.index);
  const requests = [...block.matchAll(/^npm (?:error|ERR!) 404 Not Found - GET (\S+) - Not found\r?$/gm)];
  const httpLines = stderr.match(/^npm (?:error|ERR!).* - (?:GET|HEAD|POST|PUT|DELETE|PATCH) /gm) ?? [];
  if (requests.length !== 1 || httpLines.length !== 1) return false;
  const tarball = requests[0][1];
  const packageName = [...RELEASE_PACKAGE_NAMES].find((name) => {
    const basename = name.split("/").at(-1);
    return tarball === `${PRIMARY_REGISTRY}${name}/-/${basename}-${version}.tgz`;
  });
  if (!packageName) return false;
  const resources = [...block.matchAll(/^npm (?:error|ERR!) 404\s+(?:The requested resource )?'([^']+)'(?: could not be found| is not in this registry)/gm)];
  if (resources.some((resource) => resource[1] !== `${packageName}@${tarball}`)) return false;
  signal.throwIfAborted();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("Canary tarball metadata lookup timed out")), TARBALL_METADATA_TIMEOUT_MS);
  const lookupSignal = AbortSignal.any([signal, timeout.signal]);
  const metadataUrl = `${PRIMARY_REGISTRY}${encodeURIComponent(packageName)}/${version}`;
  let response;
  try {
    // Query only registry values in the failed install's effective prefix,
    // inherited cwd and environment. Keep even warnings out of the logs:
    // configuration values can contain credentials. Config and HTTP share
    // this short deadline, inside the unchanged installation budget.
    const config = await runConfig(process.platform === "win32" ? "npm.cmd" : "npm", [
      "config", "get", "registry", "@paperclipai:registry", "--prefix", prefix,
    ], { env, signal: lookupSignal, captureStdout: true, captureStderr: true, quiet: true, outputLimit: 4096 });
    if (config.code !== 0 || config.signal || config.outputTruncated) return false;
    const lines = config.stdout.trim().split(/\r?\n/);
    if (lines.length !== 2 || !lines[0].startsWith("registry=") || !lines[1].startsWith("@paperclipai:registry=")) return false;
    const globalRegistry = lines[0].slice("registry=".length);
    const scoped = lines[1].slice("@paperclipai:registry=".length);
    const effectiveRegistry = packageName.startsWith("@") && scoped !== "undefined" ? scoped : globalRegistry;
    if (![PRIMARY_REGISTRY, PRIMARY_REGISTRY.slice(0, -1)].includes(effectiveRegistry)) return false;
    response = await withAbort(Promise.resolve(fetchMetadata(metadataUrl, {
      signal: lookupSignal, redirect: "error", credentials: "omit",
      headers: { accept: "application/json", "cache-control": "no-cache" },
    })).then((arrived) => {
      if (lookupSignal.aborted) void arrived.body?.cancel().catch(() => {});
      return arrived;
    }), lookupSignal);
    if (response.status !== 200 || response.redirected || response.url !== metadataUrl || !response.body) return false;
    const reader = response.body.getReader();
    const cancelReader = () => { void reader.cancel().catch(() => {}); };
    lookupSignal.addEventListener("abort", cancelReader, { once: true });
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        lookupSignal.throwIfAborted();
        const { done, value } = await withAbort(reader.read(), lookupSignal);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > METADATA_LIMIT_BYTES) return false;
        chunks.push(value);
      }
    } finally {
      // Initiate cleanup without extending either deadline for a transport's
      // pending/rejected cancellation acknowledgement.
      lookupSignal.removeEventListener("abort", cancelReader);
      cancelReader();
      reader.releaseLock();
    }
    lookupSignal.throwIfAborted();
    const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const integrity = manifest.dist?.integrity;
    // This validates the integrity announced by primary metadata. No tarball
    // is downloaded here, and this is not an independent content digest proof.
    return manifest.name === packageName && manifest.version === version
      && manifest.dist?.tarball === tarball && typeof integrity === "string"
      && /^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
      && Buffer.from(integrity.slice(7), "base64").toString("base64") === integrity.slice(7);
  } catch {
    signal.throwIfAborted();
    return false;
  } finally {
    void response?.body?.cancel().catch(() => {});
    clearTimeout(timer);
  }
}

function run(command, args, { env, signal, captureStderr = false, captureStdout = false, quiet = false, outputLimit = STDERR_TAIL_CHARS }) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, {
      env, detached: grouped, stdio: ["ignore", captureStdout ? "pipe" : "inherit", captureStderr ? "pipe" : "inherit"],
    });
    let stderr = quiet ? Buffer.alloc(0) : "";
    let stdout = quiet ? Buffer.alloc(0) : "";
    let outputTruncated = false;
    const retain = (previous, chunk) => {
      if (quiet) {
        outputTruncated ||= previous.length + chunk.byteLength > outputLimit;
        return Buffer.concat([previous, chunk]).subarray(-outputLimit);
      }
      // Preserve the existing install stderr character tail and ETARGET
      // behavior, including multibyte diagnostics. Only private config capture
      // uses a byte bound; any truncated E404 evidence is rejected.
      const next = previous + chunk.toString();
      outputTruncated ||= next.length > outputLimit;
      return next.slice(-outputLimit);
    };
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
      if (!quiet) process.stderr.write(chunk);
      stderr = retain(stderr, chunk);
    });
    child.stdout?.on("data", (chunk) => {
      if (!quiet) process.stdout.write(chunk);
      stdout = retain(stdout, chunk);
    });
    child.on("error", reject);
    child.on("close", async (code, exitSignal) => {
      signal.removeEventListener("abort", stop);
      await stopping;
      if (signal.aborted) reject(signal.reason);
      else resolve({ code, signal: exitSignal,
        stderr: quiet ? stderr.toString("utf8") : stderr, stdout: quiet ? stdout.toString("utf8") : stdout, outputTruncated });
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
        const retryable = !result.signal && attempt < MAX_INSTALL_ATTEMPTS
          && (missingVersion || (!result.outputTruncated
            && await canRetryPublishedTarball404(result.stderr, version, { signal: installSignal, prefix, env })));
        if (!retryable) {
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
