#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NON_SERVER_PROJECTS = [
  "@paperclipai/shared",
  "@paperclipai/db",
  "@paperclipai/adapter-utils",
  "@paperclipai/adapter-codex-local",
  "@paperclipai/adapter-opencode-local",
  "@paperclipai/ui",
  "paperclipai",
];

const ROUTE_TEST_PATTERN = /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/;
const ADDITIONAL_SERIALIZED_SERVER_TESTS = new Set([
  "server/src/__tests__/approval-routes-idempotency.test.ts",
  "server/src/__tests__/assets.test.ts",
  "server/src/__tests__/authz-company-access.test.ts",
  "server/src/__tests__/companies-route-path-guard.test.ts",
  "server/src/__tests__/company-portability.test.ts",
  "server/src/__tests__/costs-service.test.ts",
  "server/src/__tests__/express5-auth-wildcard.test.ts",
  "server/src/__tests__/health-dev-server-token.test.ts",
  "server/src/__tests__/health.test.ts",
  "server/src/__tests__/heartbeat-dependency-scheduling.test.ts",
  "server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts",
  "server/src/__tests__/heartbeat-process-recovery.test.ts",
  "server/src/__tests__/invite-accept-existing-member.test.ts",
  "server/src/__tests__/invite-accept-gateway-defaults.test.ts",
  "server/src/__tests__/invite-accept-replay.test.ts",
  "server/src/__tests__/invite-expiry.test.ts",
  "server/src/__tests__/invite-join-manager.test.ts",
  "server/src/__tests__/invite-onboarding-text.test.ts",
  "server/src/__tests__/issues-checkout-wakeup.test.ts",
  "server/src/__tests__/issues-service.test.ts",
  "server/src/__tests__/opencode-local-adapter-environment.test.ts",
  "server/src/__tests__/project-routes-env.test.ts",
  "server/src/__tests__/redaction.test.ts",
  "server/src/__tests__/routines-e2e.test.ts",
]);

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    evidenceDir: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    only: [],
    rerun: null,
    includeEmbeddedPostgresHostReady: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = path.resolve(argv[++i]);
    } else if (arg === "--evidence-dir") {
      args.evidenceDir = path.resolve(argv[++i]);
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number.parseInt(argv[++i], 10);
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--only") {
      args.only.push(argv[++i]);
    } else if (arg === "--rerun") {
      args.rerun = path.resolve(argv[++i]);
    } else if (arg === "--include-embedded-postgres-host-ready") {
      args.includeEmbeddedPostgresHostReady = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }

  return args;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir)) {
    const absolute = path.join(dir, entry);
    const stats = fs.statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...walk(absolute));
    } else if (stats.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function toRepoPath(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function toServerPath(root, file) {
  return path.relative(path.join(root, "server"), file).split(path.sep).join("/");
}

function isRouteOrAuthzTest(repoPath) {
  return ROUTE_TEST_PATTERN.test(repoPath) || ADDITIONAL_SERIALIZED_SERVER_TESTS.has(repoPath);
}

function pnpmCommandParts() {
  const pnpmExecPath = process.env.npm_execpath;
  if (pnpmExecPath) {
    return { command: process.execPath, prefixArgs: [pnpmExecPath] };
  }
  return { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", prefixArgs: [] };
}

function vitestArgs(args) {
  const { prefixArgs } = pnpmCommandParts();
  return [...prefixArgs, "exec", "vitest", "run", ...args];
}

function classifyOwner(slice) {
  if (slice.owner) return slice.owner;
  if (slice.id === "typecheck") return "workspace";
  if (slice.suite === "server-route") return "server-route";
  if (slice.suite === "server") return "server";
  if (slice.project?.includes("/ui") || slice.project === "@paperclipai/ui") return "ui";
  if (slice.project?.includes("/db") || slice.project === "@paperclipai/db") return "db";
  if (slice.project?.includes("/shared") || slice.project === "@paperclipai/shared") return "shared";
  if (slice.id?.includes("milestone") || slice.id?.includes("planning")) return "planning-tooling";
  return "unknown";
}

function safeId(value) {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
}

function createSlice(id, suite, command, args, extra = {}) {
  return {
    id,
    suite,
    command,
    args,
    phase: "release-host",
    owner: extra.owner,
    project: extra.project,
    testFile: extra.testFile,
  };
}

function buildEmbeddedPostgresHostReadySlice() {
  const { command, prefixArgs } = pnpmCommandParts();
  return createSlice(
    "embedded-postgres-host-ready",
    "embedded-postgres",
    command,
    [...prefixArgs, "run", "rt2:embedded-postgres-host-ready"],
    { owner: "db" },
  );
}

function buildReleaseSlices(root = process.cwd(), options = {}) {
  const { command, prefixArgs } = pnpmCommandParts();
  const slices = [
    createSlice("typecheck", "typecheck", command, [...prefixArgs, "run", "typecheck"], { owner: "workspace" }),
  ];

  for (const project of NON_SERVER_PROJECTS) {
    slices.push(
      createSlice(`vitest-project-${safeId(project)}`, "vitest-project", command, vitestArgs(["--project", project]), {
        project,
        owner: classifyOwner({ project }),
      }),
    );
  }

  const serverTestsDir = path.join(root, "server", "src", "__tests__");
  const routeTests = walk(serverTestsDir)
    .filter((file) => isRouteOrAuthzTest(toRepoPath(root, file)))
    .map((file) => ({
      repoPath: toRepoPath(root, file),
      serverPath: toServerPath(root, file),
    }))
    .sort((a, b) => a.repoPath.localeCompare(b.repoPath));

  const excludeRouteArgs = routeTests.flatMap((file) => ["--exclude", file.serverPath]);
  slices.push(
    createSlice("vitest-server-main", "server", command, vitestArgs(["--project", "@paperclipai/server", ...excludeRouteArgs]), {
      project: "@paperclipai/server",
      owner: "server",
    }),
  );

  for (const routeTest of routeTests) {
    slices.push(
      createSlice(
        `vitest-server-route-${safeId(routeTest.repoPath)}`,
        "server-route",
        command,
        vitestArgs([
          "--project",
          "@paperclipai/server",
          routeTest.repoPath,
          "--pool=forks",
          "--poolOptions.forks.isolate=true",
        ]),
        {
          project: "@paperclipai/server",
          testFile: routeTest.repoPath,
          owner: "server-route",
        },
      ),
    );
  }

  if (options.includeEmbeddedPostgresHostReady) {
    slices.push(buildEmbeddedPostgresHostReadySlice());
  }

  return slices.map((slice) => ({ ...slice, owner: classifyOwner(slice) }));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function latestAttemptsBySlice(attempts) {
  const latest = new Map();
  for (const attempt of attempts) {
    latest.set(attempt.sliceId, attempt);
  }
  return latest;
}

function selectSlicesForRerun(summary, allSlices) {
  const latest = latestAttemptsBySlice(summary.attempts ?? []);
  const failedIds = new Set();
  for (const [sliceId, attempt] of latest) {
    if (attempt.status === "failed" || attempt.status === "timeout" || attempt.status === "error") {
      failedIds.add(sliceId);
    }
  }
  return allSlices.filter((slice) => failedIds.has(slice.id));
}

function retryRecommendation(status) {
  if (status === "passed") return "none";
  if (status === "accepted_debt") return "run pnpm rt2:embedded-postgres-host-ready on a Windows release host";
  if (status === "timeout") return "rerun this slice on the release host; inspect duration and owner first";
  if (status === "error") return "fix harness startup error, then rerun this slice";
  return "inspect logs, fix owner area if needed, then rerun this slice";
}

function shouldEmitEmbeddedPostgresAcceptedDebt(options = {}) {
  if (options.slices) return false;
  if (options.rerun || options.includeEmbeddedPostgresHostReady) return false;
  if (process.platform !== "win32") return false;
  if (process.env.PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS === "true") return false;
  return true;
}

function createEmbeddedPostgresAcceptedDebtAttempt({ attemptNumber, timeoutMs }) {
  const now = new Date().toISOString();
  return {
    attemptNumber,
    sliceId: "embedded-postgres-windows-default-skip",
    suite: "embedded-postgres",
    phase: "release-host",
    owner: "db",
    command: "pnpm rt2:embedded-postgres-host-ready",
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    status: "accepted_debt",
    exitCode: null,
    signal: null,
    timedOut: false,
    timeoutMs,
    retryRecommendation: retryRecommendation("accepted_debt"),
    stdout: null,
    stderr: null,
    error: null,
    debt: {
      type: "embedded_postgres_windows_default_skip",
      reasonCode: "windows_default_disabled",
      reason:
        "embedded Postgres tests are disabled by default on Windows; run the focused host-ready command to verify runtime coverage",
      platform: process.platform,
      env: {
        PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS:
          process.env.PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS ?? null,
        PAPERCLIP_SKIP_EMBEDDED_POSTGRES_TESTS:
          process.env.PAPERCLIP_SKIP_EMBEDDED_POSTGRES_TESTS ?? null,
      },
    },
  };
}

function runCommand(slice, { cwd, timeoutMs, logsDir, attemptNumber }) {
  return new Promise((resolve) => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const logBase = `${String(attemptNumber).padStart(2, "0")}-${safeId(slice.id)}`;
    const stdoutRel = path.join("logs", `${logBase}.stdout.log`);
    const stderrRel = path.join("logs", `${logBase}.stderr.log`);
    const stdoutAbs = path.join(logsDir, `${logBase}.stdout.log`);
    const stderrAbs = path.join(logsDir, `${logBase}.stderr.log`);
    const stdout = fs.createWriteStream(stdoutAbs);
    const stderr = fs.createWriteStream(stderrAbs);
    let timedOut = false;
    let spawnError = null;

    const child = spawn(slice.command, slice.args, {
      cwd,
      env: {
        ...process.env,
        PAPERCLIP_RELEASE_HOST_VERIFY: "true",
        PAPERCLIP_HOME: process.env.PAPERCLIP_HOME ?? path.join(os.tmpdir(), `paperclip-release-host-${process.pid}`),
      },
      shell: false,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000).unref();
    }, timeoutMs);

    child.stdout?.pipe(stdout);
    child.stderr?.pipe(stderr);

    child.on("error", (error) => {
      spawnError = error;
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      stdout.end();
      stderr.end();
      const endedAtMs = Date.now();
      const status = spawnError ? "error" : timedOut ? "timeout" : code === 0 ? "passed" : "failed";
      resolve({
        sliceId: slice.id,
        suite: slice.suite,
        phase: slice.phase,
        owner: classifyOwner(slice),
        command: [slice.command, ...slice.args].join(" "),
        startedAt,
        endedAt: new Date(endedAtMs).toISOString(),
        durationMs: endedAtMs - startedAtMs,
        status,
        exitCode: code,
        signal,
        timedOut,
        timeoutMs,
        retryRecommendation: retryRecommendation(status),
        stdout: stdoutRel.split(path.sep).join("/"),
        stderr: stderrRel.split(path.sep).join("/"),
        error: spawnError?.message ?? null,
      });
    });
  });
}

function summarizeStatus(attempts) {
  const latest = latestAttemptsBySlice(attempts);
  const latestAttempts = [...latest.values()];
  if (latestAttempts.length === 0) return "not_run";
  if (latestAttempts.every((attempt) => attempt.status === "passed")) return "passed";
  if (latestAttempts.some((attempt) => attempt.status === "timeout")) return "timeout";
  if (latestAttempts.some((attempt) => attempt.status === "error")) return "error";
  if (latestAttempts.some((attempt) => attempt.status === "failed")) return "failed";
  if (latestAttempts.some((attempt) => attempt.status === "accepted_debt")) return "accepted_debt";
  return "failed";
}

function buildReport(summary) {
  const latest = [...latestAttemptsBySlice(summary.attempts).values()];
  const lines = [
    "# RT2 Release Host Verification",
    "",
    `Status: ${summary.status}`,
    `Run directory: \`${summary.runDir}\``,
    `Generated: ${summary.updatedAt}`,
    `Timeout per slice: ${summary.timeoutMs}ms`,
    "",
    "| Slice | Suite | Status | Duration | Owner | Retry |",
    "|-------|-------|--------|----------|-------|-------|",
  ];

  for (const attempt of latest) {
    lines.push(
      `| \`${attempt.sliceId}\` | ${attempt.suite} | ${attempt.status} | ${attempt.durationMs}ms | ${attempt.owner} | ${attempt.retryRecommendation.replace(/\|/g, "\\|")} |`,
    );
  }

  lines.push("", "## Attempts", "");
  lines.push("| Attempt | Slice | Status | Started | Logs |");
  lines.push("|---------|-------|--------|---------|------|");
  for (const attempt of summary.attempts) {
    const logs = attempt.stdout && attempt.stderr
      ? `[stdout](${attempt.stdout}) / [stderr](${attempt.stderr})`
      : attempt.status === "accepted_debt"
        ? "accepted debt"
        : "";
    lines.push(
      `| ${attempt.attemptNumber} | \`${attempt.sliceId}\` | ${attempt.status} | ${attempt.startedAt} | ${logs} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function writeSummary(summary) {
  fs.writeFileSync(path.join(summary.runDirAbs, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(summary.runDirAbs, "report.md"), buildReport(summary), "utf8");
}

async function runReleaseHostVerification(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const allSlices = options.slices ?? buildReleaseSlices(root, {
    includeEmbeddedPostgresHostReady: options.includeEmbeddedPostgresHostReady,
  });
  const existingSummary = options.existingSummary ?? null;
  const only = new Set(options.only ?? []);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runDirAbs = existingSummary
    ? path.dirname(path.resolve(existingSummary.sourcePath))
    : path.join(path.resolve(options.evidenceDir ?? path.join(root, ".planning", "release-host-runs")), timestampForPath());
  const runDir = path.relative(root, runDirAbs).split(path.sep).join("/") || ".";
  const logsDir = path.join(runDirAbs, "logs");
  ensureDir(logsDir);

  const prior = existingSummary
    ? { ...existingSummary, attempts: existingSummary.attempts ?? [] }
    : {
        version: 1,
        createdAt: new Date().toISOString(),
        attempts: [],
      };

  let selected = options.rerun ? selectSlicesForRerun(prior, allSlices) : allSlices;
  if (only.size > 0) {
    selected = selected.filter((slice) => only.has(slice.id));
  }

  const summary = {
    ...prior,
    root,
    runDir,
    runDirAbs,
    timeoutMs,
    mode: options.rerun ? "rerun" : "full",
    selectedSlices: selected.map((slice) => slice.id),
    updatedAt: new Date().toISOString(),
  };

  let attemptNumber = summary.attempts.length + 1;
  if (!existingSummary && shouldEmitEmbeddedPostgresAcceptedDebt(options)) {
    summary.attempts.push(createEmbeddedPostgresAcceptedDebtAttempt({ attemptNumber, timeoutMs }));
    summary.status = summarizeStatus(summary.attempts);
    summary.updatedAt = new Date().toISOString();
    writeSummary(summary);
    attemptNumber += 1;
  }

  for (const slice of selected) {
    const attempt = await runCommand(slice, { cwd: root, timeoutMs, logsDir, attemptNumber });
    summary.attempts.push({ attemptNumber, ...attempt });
    summary.status = summarizeStatus(summary.attempts);
    summary.updatedAt = new Date().toISOString();
    writeSummary(summary);
    attemptNumber += 1;
  }

  if (selected.length === 0) {
    summary.status = summarizeStatus(summary.attempts);
    summary.updatedAt = new Date().toISOString();
    writeSummary(summary);
  }

  return summary;
}

function printText(summary) {
  console.log("# RT2 Release Host Verification");
  console.log("");
  console.log(`Status: ${summary.status}`);
  console.log(`Summary: ${path.join(summary.runDir, "summary.json").split(path.sep).join("/")}`);
  console.log(`Report: ${path.join(summary.runDir, "report.md").split(path.sep).join("/")}`);
  console.log(`Selected slices: ${summary.selectedSlices.length}`);
}

function printHelp() {
  console.log(`Usage: node scripts/rt2-release-host-verify.mjs [options]

Options:
  --root <path>           Repository root (default: cwd)
  --evidence-dir <path>   Evidence parent directory (default: .planning/release-host-runs)
  --timeout-ms <ms>       Timeout per slice (default: ${DEFAULT_TIMEOUT_MS})
  --only <slice-id>       Run only a specific slice; repeatable
  --rerun <summary.json>  Rerun latest failed/timed-out/error slices from a prior summary
  --include-embedded-postgres-host-ready
                         Run the focused embedded Postgres host-ready slice instead of reporting Windows default skip as accepted debt
  --json                  Print JSON summary
  --help                  Show this help
`);
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      return;
    }

    const existingSummary = args.rerun ? { ...readJson(args.rerun), sourcePath: args.rerun } : null;
    const summary = await runReleaseHostVerification({
      root: args.root,
      evidenceDir: args.evidenceDir,
    timeoutMs: args.timeoutMs,
    only: args.only,
    rerun: Boolean(args.rerun),
    includeEmbeddedPostgresHostReady: args.includeEmbeddedPostgresHostReady,
    existingSummary,
  });

    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printText(summary);
    }

    process.exit(summary.status === "passed" || summary.status === "accepted_debt" ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("rt2-release-host-verify.mjs")) {
  main();
}

export {
  buildReleaseSlices,
  buildEmbeddedPostgresHostReadySlice,
  buildReport,
  classifyOwner,
  createEmbeddedPostgresAcceptedDebtAttempt,
  runReleaseHostVerification,
  selectSlicesForRerun,
  summarizeStatus,
};
