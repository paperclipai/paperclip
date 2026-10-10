import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { HERMES_CLOSURES } from "../src/drivers/acpx/hermes-distributions.ts";
import { hermesProvisioningConfig } from "./hermes-provisioning-config.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");

/** Download the same pinned GitHub archive without the unauthenticated API quota. */
export async function downloadPinnedHermesArchive(version, {
  request = fetch, wait = delay, now = Date.now, timeout = AbortSignal.timeout,
} = {}) {
  const deadline = now() + 120_000;
  const retryWait = async (waitMs, failure) => {
    if (waitMs > 30_000) {
      throw new Error(`${failure}; retry setup later after the download service's rate limit expires`);
    }
    if (waitMs + 1 >= deadline - now()) throw new Error(`${failure}; overall download deadline exceeded; retry setup later`);
    await wait(waitMs);
  };
  const url = `https://codeload.github.com/NousResearch/hermes-agent/legacy.tar.gz/${version.commit}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Hermes source download deadline exceeded; retry setup later");
    let response;
    let bytes;
    try {
      response = await request(url, { signal: timeout(remaining) });
      if (response.ok) bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      if (deadline <= now()) throw new Error("Hermes source download deadline exceeded; retry setup later");
      const failure = `Hermes source download failed: network error after ${attempt} attempts`;
      if (attempt === 3) throw new Error(`${failure}; retry setup later`);
      await retryWait(attempt * 1_000, failure);
      continue;
    }
    if (response.ok) {
      if (digest(bytes) !== version.archiveSha256) throw new Error("Hermes source digest mismatch");
      return bytes;
    }
    await response.body?.cancel().catch(() => undefined);
    const failure = `Hermes source download failed: HTTP ${response.status}`;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
      throw new Error(`${failure}${attempt > 1 ? ` after ${attempt} attempts` : ""}; retry setup later`);
    }
    const retryAfter = response.headers.get("retry-after");
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const retryAt = retryAfter === null ? NaN : Date.parse(retryAfter);
    const waitMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1_000)
      : Number.isFinite(retryAt) ? Math.max(0, retryAt - now()) : attempt * 1_000;
    await retryWait(waitMs, failure);
  }
}

/** Source provisioning and the public setup command share one pinned operation. */
export async function materializePinnedHermesDistribution({ destination, provider, materializer, verify }) {
  if (!destination || !isAbsolute(destination) || resolve(destination) !== destination || destination.includes("\0")) throw new Error("Hermes provisioning requires a new normalized absolute destination");
  const expectedClosureSha256 = HERMES_CLOSURES[`${process.platform}-${process.arch}`];
  if (!expectedClosureSha256) throw new Error("Hermes platform is not a qualification target");
  const version = JSON.parse(await readFile(join(provider, "version.json"), "utf8"));
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (await realpath(dirname(destination)) !== dirname(destination)) throw new Error("Hermes provisioning parent must be a real directory");
  const existing = await lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing) throw new Error("Hermes provisioning destination already exists; refusing to overwrite it");
  const temporary = await mkdtemp(join(dirname(destination), ".hermes-install-"));
  const source = join(temporary, "source");
  const prepared = join(temporary, "distribution");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", HOME: join(temporary, "home"),
    UV_CACHE_DIR: join(temporary, "uv-cache"), UV_PYTHON_INSTALL_DIR: join(temporary, "uv-python") };
  try {
    await mkdir(source, { mode: 0o700 });
    await mkdir(env.HOME, { mode: 0o700 });
    let uvVersion;
    try { uvVersion = execFileSync("uv", ["--version"], { env, encoding: "utf8", timeout: 10000 }); }
    catch (error) { if (error.code === "ENOENT") throw new Error("Hermes setup requires uv 0.12.17 on PATH. Install that version and retry setup."); throw error; }
    if (!/^uv 0\.12\.17(?:\s|$)/.test(uvVersion)) throw new Error("Hermes provisioning requires uv 0.12.17; install that version before provisioning");
    const bytes = await downloadPinnedHermesArchive(version);
    const archive = join(temporary, "source.tar.gz");
    await writeFile(archive, bytes, { mode: 0o600, flag: "wx" });
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", source], { env, timeout: 30000 });
    if (digest(await readFile(join(source, "uv.lock"))) !== version.lockSha256) throw new Error("Hermes dependency lock digest mismatch");
    const configFile = join(temporary, "uv.toml");
    await writeFile(configFile, hermesProvisioningConfig(await readFile(join(source, "pyproject.toml"), "utf8")), { mode: 0o600, flag: "wx" });
    execFileSync("uv", ["sync", "--locked", "--config-file", configFile, "--no-dev", "--no-install-project", "--python", version.python,
      "--extra", "acp", "--extra", "mcp", "--extra", "anthropic", "--extra", "bedrock", "--extra", "google"], { cwd: source, env, stdio: "inherit", timeout: 300000 });
    if (digest(await readFile(join(source, "uv.lock"))) !== version.lockSha256) throw new Error("Hermes dependency lock changed during installation");
    execFileSync(join(source, ".venv/bin/python"), [materializer, source, prepared, provider], { env, stdio: "inherit", timeout: 120000 });
    const manifest = JSON.parse(await readFile(join(prepared, "manifest.json"), "utf8"));
    if (digest(JSON.stringify(manifest.entries)) !== expectedClosureSha256) throw new Error("Hermes provisioned closure does not match its reviewed pin");
    // Public setup checks every execution byte before publication. Native admission
    // repeats that verification before the runtime stages credentials.
    await verify?.(prepared, expectedClosureSha256);
    const conflict = await lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    if (conflict) throw new Error("Hermes destination changed during setup; refusing to overwrite it");
    await rename(prepared, destination);
    return { destination, closureSha256: expectedClosureSha256, version: version.release };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1]?.endsWith("/provision-hermes.mjs") && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  access(join(root, "src/providers/hermes/version.json")).then(() => join(root, "src/providers/hermes"), () => join(root, "dist/providers/hermes"))
    .then(provider => materializePinnedHermesDistribution({ destination: process.argv[2], provider, materializer: join(root, "scripts/materialize-hermes.py") }))
    .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
