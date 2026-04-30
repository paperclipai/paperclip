/**
 * Auto-prep helpers for aider_local. The adapter follows a "just works" rule:
 * if a prerequisite is missing, install/pull it automatically and stream the
 * progress to onLog so the user sees what's happening rather than a cryptic
 * "command not found" failure.
 *
 * Two things can be auto-prepared:
 *   1. The `aider` CLI itself, via `pip install --user aider-chat`.
 *   2. The configured Ollama model, via the Ollama HTTP API (`POST /api/pull`).
 *
 * Three things we *don't* try to auto-install (the cost/risk is too high):
 *   - Python — install paths vary wildly across distros; surface a clear
 *     instruction instead.
 *   - Ollama itself — multi-hundred-MB binary that registers a service. The
 *     Adapters page already shows a "Local Ollama unreachable" badge if it
 *     isn't running; that's the right place to drive setup.
 *   - GPU drivers / CUDA — out of scope.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { ensureAdapterExecutionTargetCommandResolvable } from "@paperclipai/adapter-utils/execution-target";

export type OnLog = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

const IS_WINDOWS = process.platform === "win32";

/** Path to a paperclip-managed venv where we install aider when the system
 *  Python refuses (PEP 668) or the user has no preferred install method. */
function managedVenvPath(): string {
  return path.join(os.homedir(), ".paperclip", "aider-venv");
}

function venvBinDir(venv: string): string {
  return path.join(venv, IS_WINDOWS ? "Scripts" : "bin");
}

function venvExecutable(venv: string, name: string): string {
  return path.join(venvBinDir(venv), IS_WINDOWS ? `${name}.exe` : name);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Prepend a directory to env.PATH (mutates env). Handles Windows' Path/PATH casing. */
function prependPath(env: NodeJS.ProcessEnv, dir: string): void {
  const sep = IS_WINDOWS ? ";" : ":";
  // Windows process env can have either PATH or Path; the spawn helpers read PATH.
  const current = env.PATH ?? env.Path ?? "";
  env.PATH = current ? `${dir}${sep}${current}` : dir;
  if (IS_WINDOWS) delete env.Path; // avoid the duplicate that Node sometimes leaves behind
}

/**
 * Python interpreter resolution. Aider's `Requires-Python` is currently
 * `>=3.10,<3.13`, so we only accept 3.10, 3.11, or 3.12. We probe each
 * candidate, parse `python --version`, and skip anything outside that range.
 * Bare `python`/`py` are tested too — they pick up the user's default
 * interpreter, which on a clean modern Windows install is now often 3.13
 * (incompatible) but on macOS/Linux is usually a 3.10–3.12 distro Python.
 *
 * The Windows `py` launcher accepts `-3.12` etc.; entries are full argv
 * arrays so `py -3.12` is one candidate.
 */
const PYTHON_CANDIDATES: string[][] = [
  // Versioned Windows-launcher candidates first — these only succeed when
  // the specific version is installed, so the version filter below is just
  // a belt-and-braces check.
  ["py", "-3.12"],
  ["py", "-3.11"],
  ["py", "-3.10"],
  // Versioned Unix-style candidates next.
  ["python3.12"],
  ["python3.11"],
  ["python3.10"],
  // Bare candidates last — version filter does the actual gatekeeping here.
  ["py"],
  ["python3"],
  ["python"],
];

/** Aider's Requires-Python range as of 2026: >=3.10,<3.13. */
const AIDER_PYTHON_MIN_MINOR = 10;
const AIDER_PYTHON_MAX_MINOR_EXCLUSIVE = 13; // i.e. accept 3.10, 3.11, 3.12; reject 3.13+
const AIDER_PYTHON_REQUIREMENT_LABEL = "3.10, 3.11, or 3.12";

/**
 * python-build-standalone is Astral's project that ships pre-built portable
 * CPython distributions (the same thing uv, mise, and pipx-equivalents use).
 * The "install_only" variant is a self-contained ~30MB tarball that doesn't
 * need to be `make install`-ed — just extract and run.
 *
 * We pin a specific release date + 3.12 patch so the URL is deterministic
 * and reproducible across user machines. Bumping these strings to a newer
 * release is a one-line change.
 */
const BUNDLED_PYTHON_RELEASE_DATE = "20240814";
const BUNDLED_PYTHON_VERSION = "3.12.5";

/** Path where the bootstrapped Python lives, shared across paperclip instances. */
function bundledPythonRoot(): string {
  return path.join(os.homedir(), ".paperclip", "python", BUNDLED_PYTHON_VERSION);
}

/** Path to the Python interpreter inside the extracted distribution. */
function bundledPythonExecutable(root: string): string {
  // python-build-standalone install_only tarballs unpack into a top-level
  // `python/` directory regardless of platform. Inside it:
  //   Windows: python/python.exe
  //   Unix:    python/bin/python3.12
  return IS_WINDOWS
    ? path.join(root, "python", "python.exe")
    : path.join(root, "python", "bin", `python${BUNDLED_PYTHON_VERSION.split(".").slice(0, 2).join(".")}`);
}

function bundledPythonDownloadUrl(): string | null {
  const triple = (() => {
    if (process.platform === "win32") {
      return process.arch === "arm64"
        ? "aarch64-pc-windows-msvc"
        : "x86_64-pc-windows-msvc";
    }
    if (process.platform === "darwin") {
      return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
    }
    if (process.platform === "linux") {
      // Default to glibc (most common). musl users (Alpine) need a different
      // triple; we'll add detection if/when a user reports breakage.
      return process.arch === "arm64"
        ? "aarch64-unknown-linux-gnu"
        : "x86_64-unknown-linux-gnu";
    }
    return null;
  })();
  if (!triple) return null;
  return (
    `https://github.com/astral-sh/python-build-standalone/releases/download/` +
    `${BUNDLED_PYTHON_RELEASE_DATE}/` +
    `cpython-${BUNDLED_PYTHON_VERSION}+${BUNDLED_PYTHON_RELEASE_DATE}-${triple}-install_only.tar.gz`
  );
}

/**
 * Download python-build-standalone, extract it, and return a path-and-exe
 * tuple ready to be fed to tryInstallToManagedVenv. Streams download
 * progress to onLog so the user sees ~"Downloading Python 3.12 47%…".
 *
 * Returns null on any failure — the caller should fall through to a clear
 * error message that points at https://python.org as the manual cure.
 */
async function bootstrapBundledPython(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLog: OnLog;
}): Promise<{ argv: string[]; pythonExe: string; versionLabel: string } | null> {
  const root = bundledPythonRoot();
  const exe = bundledPythonExecutable(root);

  // Reuse existing install if a previous run already bootstrapped.
  if (await fileExists(exe)) {
    await input.onLog(
      "stdout",
      `[paperclip] Using paperclip-bundled Python at ${exe}.\n`,
    );
    return { argv: [exe], pythonExe: exe, versionLabel: BUNDLED_PYTHON_VERSION };
  }

  const url = bundledPythonDownloadUrl();
  if (!url) {
    await input.onLog(
      "stderr",
      `[paperclip] No bundled Python available for ${process.platform}/${process.arch}.\n`,
    );
    return null;
  }

  await input.onLog(
    "stdout",
    `[paperclip] No compatible Python on this machine. Downloading Python ${BUNDLED_PYTHON_VERSION} just for paperclip from ${url}\n`,
  );

  await fs.mkdir(root, { recursive: true });
  const archivePath = path.join(root, "python-dist.tar.gz");

  // Download with progress streaming.
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) {
      await input.onLog(
        "stderr",
        `[paperclip] Python download failed: HTTP ${res.status} ${res.statusText}.\n`,
      );
      return null;
    }
    const total = Number(res.headers.get("content-length") ?? 0);
    const reader = res.body.getReader();
    const out = await fs.open(archivePath, "w");
    let downloaded = 0;
    let lastReportedPercent = -10;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          await out.write(value);
          downloaded += value.length;
          if (total > 0) {
            const percent = Math.floor((downloaded / total) * 100);
            if (percent >= lastReportedPercent + 10) {
              await input.onLog(
                "stdout",
                `[paperclip] Downloading Python… ${percent}% (${(downloaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB)\n`,
              );
              lastReportedPercent = percent;
            }
          }
        }
      }
    } finally {
      await out.close();
    }
    await input.onLog(
      "stdout",
      `[paperclip] Download complete (${(downloaded / 1024 / 1024).toFixed(1)} MB). Extracting…\n`,
    );
  } catch (err) {
    await input.onLog(
      "stderr",
      `[paperclip] Python download failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }

  // Extract via the system `tar`. Built into Windows 10 1803+, macOS, and
  // every Linux. Avoids pulling in a tar npm dep just for this codepath.
  const tarProc = await runChildProcess(
    `aider-prep-untar-${Date.now().toString(36)}`,
    "tar",
    ["-xzf", archivePath, "-C", root],
    {
      cwd: input.cwd,
      env: compactEnv(input.env),
      timeoutSec: 300,
      graceSec: 5,
      onLog: input.onLog,
    },
  );
  if (tarProc.timedOut || (tarProc.exitCode ?? 1) !== 0) {
    await input.onLog(
      "stderr",
      `[paperclip] Extraction via tar failed (exit ${tarProc.exitCode}). On Windows, ensure tar is on PATH (built into Windows 10 1803+).\n`,
    );
    return null;
  }

  // Tidy the archive once extraction succeeded — saves ~30MB.
  await fs.unlink(archivePath).catch(() => {});

  if (!(await fileExists(exe))) {
    await input.onLog(
      "stderr",
      `[paperclip] Extraction succeeded but expected Python at ${exe} is missing. Aborting bootstrap.\n`,
    );
    return null;
  }

  await input.onLog(
    "stdout",
    `[paperclip] Bundled Python installed at ${exe}. Using it for the rest of this run.\n`,
  );
  return { argv: [exe], pythonExe: exe, versionLabel: BUNDLED_PYTHON_VERSION };
}

/** Drop undefined values so we can hand a strict Record<string,string> to runChildProcess. */
function compactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

async function isCommandResolvable(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, null, cwd, env);
    return true;
  } catch {
    return false;
  }
}

interface PythonScan {
  /** Compatible interpreter, or null if none found. */
  compatible: {
    argv: string[];
    /** Absolute path to python.exe / python3, for `pipx --python` and direct invocation. */
    pythonExe: string;
    /** Version string like "3.12.5" for log messages. */
    versionLabel: string;
  } | null;
  /**
   * Every Python invocation we successfully probed (whether compatible or not),
   * so the caller can build an actionable error like "Found Python 3.13 and
   * 3.14 but Aider requires 3.10–3.12; install 3.12".
   */
  observed: Array<{ command: string; version: string; compatible: boolean }>;
}

const PYTHON_VERSION_REGEX = /Python (\d+)\.(\d+)\.(\d+)/;

/**
 * Probe candidate Python invocations and return the first whose version
 * satisfies Aider's Requires-Python. Records every interpreter we see (not
 * just the chosen one) so the failure path can name what the user has.
 */
async function scanForCompatiblePython(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<PythonScan> {
  const observed: PythonScan["observed"] = [];

  for (const argv of PYTHON_CANDIDATES) {
    const [head, ...rest] = argv;
    if (!head) continue;
    if (!(await isCommandResolvable(head, cwd, env))) continue;

    const versionProbe = await runChildProcess(
      `aider-prep-pyprobe-${Date.now().toString(36)}`,
      head,
      [...rest, "--version"],
      {
        cwd,
        env: compactEnv(env),
        timeoutSec: 10,
        graceSec: 2,
        onLog: async () => {},
      },
    );
    if (versionProbe.timedOut || (versionProbe.exitCode ?? 1) !== 0) continue;

    const match = (versionProbe.stdout + versionProbe.stderr).match(PYTHON_VERSION_REGEX);
    if (!match) continue;
    const major = Number.parseInt(match[1] ?? "0", 10);
    const minor = Number.parseInt(match[2] ?? "0", 10);
    const versionLabel = `${match[1]}.${match[2]}.${match[3]}`;
    const compatible =
      major === 3 &&
      minor >= AIDER_PYTHON_MIN_MINOR &&
      minor < AIDER_PYTHON_MAX_MINOR_EXCLUSIVE;
    observed.push({ command: argv.join(" "), version: versionLabel, compatible });

    if (!compatible) continue;

    // Resolve the absolute python.exe path so pipx --python / venv creation
    // can target this exact interpreter without re-resolving.
    const exeProbe = await runChildProcess(
      `aider-prep-pyexe-${Date.now().toString(36)}`,
      head,
      [...rest, "-c", "import sys; print(sys.executable)"],
      {
        cwd,
        env: compactEnv(env),
        timeoutSec: 10,
        graceSec: 2,
        onLog: async () => {},
      },
    );
    if (exeProbe.timedOut || (exeProbe.exitCode ?? 1) !== 0) continue;
    const pythonExe = exeProbe.stdout.trim();
    if (!pythonExe) continue;

    return {
      compatible: { argv, pythonExe, versionLabel },
      observed,
    };
  }

  return { compatible: null, observed };
}

function platformInstallHint(): string {
  switch (process.platform) {
    case "win32":
      return `Install Python 3.12 from https://python.org/downloads/release/python-3127/ (check "Add to PATH" during install). It coexists with any other versions you have installed; the Windows \`py\` launcher will pick it up automatically.`;
    case "darwin":
      return `Install Python 3.12 with \`brew install python@3.12\` (or download from https://python.org/downloads). Both coexist with any other Python versions on your Mac.`;
    default:
      return `Install Python 3.12 with your distro's package manager (Debian/Ubuntu: \`apt install python3.12\`; Fedora: \`dnf install python3.12\`; Arch: \`pacman -S python\`) or pyenv (\`pyenv install 3.12\`).`;
  }
}

function buildPythonMissingErrorMessage(scan: PythonScan): string {
  if (scan.observed.length === 0) {
    return (
      `Aider needs Python ${AIDER_PYTHON_REQUIREMENT_LABEL} and no Python interpreter was found on PATH. ` +
      platformInstallHint() +
      ` Then restart Paperclip and retry.`
    );
  }
  const summary = scan.observed
    .map((o) => `${o.command} → Python ${o.version} (${o.compatible ? "compatible" : "too new"})`)
    .join("; ");
  return (
    `Aider requires Python ${AIDER_PYTHON_REQUIREMENT_LABEL}. ` +
    `Python is installed but the available versions are not compatible: ${summary}. ` +
    platformInstallHint() +
    ` Then restart Paperclip and retry.`
  );
}

/**
 * Try to install aider into a paperclip-managed venv at ~/.paperclip/aider-venv/.
 * This is the most portable fallback because it:
 *   - bypasses PEP 668 (`error: externally-managed-environment` on Debian 12+,
 *     Ubuntu 23.04+, Fedora 39+) — venvs are explicitly allowed by PEP 668
 *   - sidesteps system-Python permission and PATH issues entirely
 *   - never modifies the user's site-packages
 *
 * Returns true on success. Mutates `env.PATH` to prepend the venv's bin dir
 * so subsequent `aider` resolution picks up our binary.
 */
async function tryInstallToManagedVenv(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  python: string[]; // pre-validated compatible Python invocation, e.g. ["py", "-3.12"]
  onLog: OnLog;
}): Promise<boolean> {
  const venv = managedVenvPath();
  const venvAider = venvExecutable(venv, "aider");
  const venvPython = venvExecutable(venv, IS_WINDOWS ? "python" : "python3");

  // If a previous prep already built this venv, just reuse it.
  if (await fileExists(venvAider)) {
    prependPath(input.env, venvBinDir(venv));
    await input.onLog("stdout", `[paperclip] Using existing managed venv at ${venv}.\n`);
    return true;
  }

  const pyDescription = input.python.join(" ");

  await input.onLog(
    "stdout",
    `[paperclip] Creating paperclip-managed venv for aider at ${venv} (using ${pyDescription}).\n`,
  );

  await fs.mkdir(path.dirname(venv), { recursive: true });
  const venvProc = await runChildProcess(
    `aider-prep-venv-${Date.now().toString(36)}`,
    input.python[0]!,
    [...input.python.slice(1), "-m", "venv", venv],
    {
      cwd: input.cwd,
      env: compactEnv(input.env),
      timeoutSec: 60,
      graceSec: 5,
      onLog: input.onLog,
    },
  );
  if (venvProc.timedOut || (venvProc.exitCode ?? 1) !== 0) {
    await input.onLog(
      "stderr",
      `[paperclip] venv creation failed (exit ${venvProc.exitCode}); cannot fall back further.\n`,
    );
    return false;
  }

  if (!(await fileExists(venvPython))) {
    await input.onLog(
      "stderr",
      `[paperclip] venv was created but ${venvPython} is missing; cannot install into it.\n`,
    );
    return false;
  }

  // Step 1: pre-install pip/setuptools/wheel in the venv. This must happen
  // BEFORE the aider install because aider's transitive deps include sdists
  // (aiohttp, numpy, etc.) that need a build backend. With normal build
  // isolation pip would fetch setuptools into a new sandbox per build, but
  // that sandbox often doesn't see anything — hence the `Cannot import
  // 'setuptools.build_meta'` errors. Putting setuptools in the venv's
  // site-packages and disabling build isolation in step 2 sidesteps it.
  await input.onLog(
    "stdout",
    `[paperclip] Installing build tools into venv: ${venvPython} -m pip install --upgrade pip setuptools wheel\n`,
  );
  const buildToolsProc = await runChildProcess(
    `aider-prep-venvtools-${Date.now().toString(36)}`,
    venvPython,
    ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
    {
      cwd: input.cwd,
      env: compactEnv(input.env),
      timeoutSec: 300,
      graceSec: 5,
      onLog: input.onLog,
    },
  );
  if (buildToolsProc.timedOut || (buildToolsProc.exitCode ?? 1) !== 0) {
    await input.onLog(
      "stderr",
      `[paperclip] Failed to install build tools into venv (exit ${buildToolsProc.exitCode}); cannot continue.\n`,
    );
    return false;
  }

  // Step 2: install aider with --no-build-isolation so any sdist transitive
  // dep uses the setuptools+wheel we just put in the venv. Pin to a recent-
  // enough aider-chat to avoid pip's resolver landing on the May 2023 0.16.0
  // (whose `==`-pinned deps don't have wheels for Python 3.13 and chain into
  // the same build-isolation failure mode).
  await input.onLog(
    "stdout",
    `[paperclip] Installing aider into venv: ${venvPython} -m pip install --no-build-isolation "aider-chat>=0.50"\n`,
  );
  const installProc = await runChildProcess(
    `aider-prep-venvinstall-${Date.now().toString(36)}`,
    venvPython,
    ["-m", "pip", "install", "--no-build-isolation", "aider-chat>=0.50"],
    {
      cwd: input.cwd,
      env: compactEnv(input.env),
      timeoutSec: 900,
      graceSec: 5,
      onLog: input.onLog,
    },
  );
  if (installProc.timedOut || (installProc.exitCode ?? 1) !== 0) {
    return false;
  }

  if (!(await fileExists(venvAider))) {
    await input.onLog(
      "stderr",
      `[paperclip] venv install completed but ${venvAider} not found; falling through.\n`,
    );
    return false;
  }

  prependPath(input.env, venvBinDir(venv));
  await input.onLog("stdout", `[paperclip] Aider installed into managed venv. Path prepended for this run.\n`);
  return true;
}

/**
 * Ensure `aider` is on PATH; if not, install it. Strategy (each step tried
 * only when the previous one fails or doesn't apply):
 *
 *   0. **Existing managed venv** — if a previous run installed into
 *      ~/.paperclip/aider-venv/, prepend its bin dir to PATH and reuse.
 *   1. **System aider** — if `aider` is already on the user's PATH, do nothing.
 *   2. **pipx** — if `pipx` is available, `pipx install aider-chat`. pipx
 *      creates an isolated venv with setuptools already in place, so it
 *      sidesteps the build-isolation issues plain pip hits on Python 3.13+.
 *   3. **Paperclip-managed venv** — create ~/.paperclip/aider-venv/, install
 *      pip+setuptools+wheel into it, then install aider with
 *      `--no-build-isolation` so any sdist transitive dep can use the venv's
 *      setuptools to build. This works on every modern platform — bypasses
 *      PEP 668 (Debian 12+/Ubuntu 23+/Fedora 39+), avoids host-Python build-
 *      isolation failures (Python 3.13/3.14 with old aider deps), and gives
 *      us a known absolute path to the binary so PATH games are unnecessary.
 *
 * The pip-`--user` path that sat at #3 in earlier versions has been removed
 * — `pip install --user` triggers `BackendUnavailable` on Python 3.13+ when
 * resolver lands on `aider-chat 0.16.0` (whose deps are sdists), and there's
 * no clean way to fix it short of disabling build isolation, which the venv
 * path handles correctly. Keeping pip-`--user` around just gave users a
 * confusing intermediate failure before the venv attempt.
 */
export async function ensureAiderInstalled(input: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLog: OnLog;
}): Promise<void> {
  // Path 0: a previous run may have installed into the managed venv. Cheap
  // existence check beats re-running anything.
  const existingVenvAider = venvExecutable(managedVenvPath(), "aider");
  if (await fileExists(existingVenvAider)) {
    prependPath(input.env, venvBinDir(managedVenvPath()));
    if (await isCommandResolvable(input.command, input.cwd, input.env)) {
      await input.onLog(
        "stdout",
        `[paperclip] Resolved aider via managed venv at ${managedVenvPath()}.\n`,
      );
      return;
    }
  }

  // Path 1: user already has aider on PATH.
  if (await isCommandResolvable(input.command, input.cwd, input.env)) return;

  await input.onLog(
    "stdout",
    `[paperclip] "${input.command}" is not on PATH — attempting auto-install.\n`,
  );

  // Find a Python 3.10–3.12 interpreter (Aider's Requires-Python). pipx and
  // venv both need one. If the user only has 3.13/3.14 (or no Python at all),
  // we bootstrap a paperclip-bundled Python 3.12 from python-build-standalone
  // — a portable distribution that lives entirely in ~/.paperclip/python/
  // and never touches system Python.
  const initialScan = await scanForCompatiblePython(input.cwd, input.env);
  let chosenPython = initialScan.compatible;
  if (!chosenPython) {
    if (initialScan.observed.length > 0) {
      await input.onLog(
        "stderr",
        `[paperclip] Found Python but no compatible version: ${initialScan.observed
          .map((o) => `${o.command} (${o.version}, ${o.compatible ? "ok" : "too new"})`)
          .join("; ")}\n`,
      );
    } else {
      await input.onLog("stderr", `[paperclip] No Python interpreter found on PATH.\n`);
    }
    const bootstrapped = await bootstrapBundledPython({
      cwd: input.cwd,
      env: input.env,
      onLog: input.onLog,
    });
    if (!bootstrapped) {
      throw new Error(buildPythonMissingErrorMessage(initialScan));
    }
    chosenPython = bootstrapped;
  }
  await input.onLog(
    "stdout",
    `[paperclip] Using Python ${chosenPython.versionLabel} at ${chosenPython.pythonExe}.\n`,
  );

  // Path 2: pipx with explicit --python pointing at our compatible interpreter.
  // Skipped when the chosen Python is the paperclip-bundled one — pipx would
  // then go off and create yet another venv layer for no benefit; the managed
  // venv path is more direct.
  const usingBundledPython = chosenPython.pythonExe.startsWith(bundledPythonRoot());
  if (!usingBundledPython && (await isCommandResolvable("pipx", input.cwd, input.env))) {
    await input.onLog(
      "stdout",
      `[paperclip] Found pipx. Running: pipx install --python "${chosenPython.pythonExe}" aider-chat\n`,
    );
    const pipxProc = await runChildProcess(
      `aider-prep-pipx-${Date.now().toString(36)}`,
      "pipx",
      ["install", "--python", chosenPython.pythonExe, "aider-chat"],
      {
        cwd: input.cwd,
        env: compactEnv(input.env),
        timeoutSec: 600,
        graceSec: 5,
        onLog: input.onLog,
      },
    );
    if (!pipxProc.timedOut && (pipxProc.exitCode ?? 1) === 0) {
      if (await isCommandResolvable(input.command, input.cwd, input.env)) {
        await input.onLog("stdout", `[paperclip] Aider installed via pipx and on PATH.\n`);
        return;
      }
      await input.onLog(
        "stderr",
        `[paperclip] pipx installed aider but "${input.command}" is not yet on PATH. Falling back to managed venv.\n`,
      );
    } else {
      await input.onLog(
        "stderr",
        `[paperclip] pipx install failed (exit ${pipxProc.exitCode}); falling back to managed venv.\n`,
      );
    }
  }

  // Path 3: paperclip-managed venv with --no-build-isolation. Most reliable.
  if (
    await tryInstallToManagedVenv({
      cwd: input.cwd,
      env: input.env,
      python: chosenPython.argv,
      onLog: input.onLog,
    })
  ) {
    if (await isCommandResolvable(input.command, input.cwd, input.env)) {
      return;
    }
  }

  throw new Error(
    `Aider install failed via pipx and the paperclip-managed venv fallback, ` +
      `even though a compatible Python (${chosenPython.versionLabel}) was found at ${chosenPython.pythonExe}. ` +
      `Check the run log above for the exact pip error — common causes are no internet, antivirus blocking pip, ` +
      `or a corrupt Python install.`,
  );
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

interface OllamaPullEvent {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

function modelTagFromAiderId(aiderModel: string): string | null {
  const m = aiderModel.match(/^ollama\/(.+)$/);
  return m ? m[1] ?? null : null;
}

async function listPulledOllamaModels(baseUrl: string): Promise<string[] | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = (await res.json()) as OllamaTagsResponse;
    return (body.models ?? [])
      .map((m) => (typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : null))
      .filter((s): s is string => s != null);
  } catch {
    return null;
  }
}

/**
 * Ensure the configured Ollama model is pulled. If not, stream `POST /api/pull`
 * progress to onLog. Best-effort: if Ollama is unreachable or the pull fails,
 * we let the actual `aider` invocation fail with the same error so the run UI
 * surfaces a single clear failure instead of two competing ones.
 */
export async function ensureOllamaModelPulled(input: {
  aiderModel: string;
  ollamaBaseUrl: string;
  onLog: OnLog;
}): Promise<void> {
  const tag = modelTagFromAiderId(input.aiderModel);
  if (!tag) return; // Non-Ollama model (e.g. user pointed at a different provider through Aider).

  const pulled = await listPulledOllamaModels(input.ollamaBaseUrl);
  if (pulled === null) {
    // Ollama unreachable. Don't fail here — let aider's spawn fail with the
    // upstream error message so we don't double-report.
    return;
  }
  if (pulled.some((name) => name === tag || name.startsWith(`${tag}@`))) return;

  await input.onLog(
    "stdout",
    `[paperclip] Ollama model "${tag}" is not pulled. Streaming "ollama pull ${tag}" via the API…\n`,
  );

  const url = `${input.ollamaBaseUrl.replace(/\/$/, "")}/api/pull`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: tag, stream: true }),
  });
  if (!res.ok || !res.body) {
    await input.onLog(
      "stderr",
      `[paperclip] Ollama pull request failed: HTTP ${res.status}. Falling through; aider will surface the underlying error.\n`,
    );
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastStatus = "";
  let lastPercent = -1;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: OllamaPullEvent;
      try {
        event = JSON.parse(line) as OllamaPullEvent;
      } catch {
        continue;
      }
      if (event.error) {
        await input.onLog("stderr", `[paperclip ollama] error: ${event.error}\n`);
        continue;
      }
      const percent =
        event.total && event.completed != null
          ? Math.floor((event.completed / event.total) * 100)
          : null;
      // Throttle: only log on status change or 5%-step progress update.
      if (
        event.status &&
        (event.status !== lastStatus || (percent != null && percent >= lastPercent + 5))
      ) {
        const pctText = percent != null ? ` ${percent}%` : "";
        await input.onLog("stdout", `[paperclip ollama] ${event.status}${pctText}\n`);
        lastStatus = event.status;
        if (percent != null) lastPercent = percent;
      }
    }
  }

  await input.onLog("stdout", `[paperclip] Pulled ${tag}.\n`);
}
