#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_SUITES = [
  "packages/db/src/client.test.ts",
  "packages/db/src/rt2-task-persistence.test.ts",
  "packages/db/src/rt2-daily-report-persistence.test.ts",
];

const SERVER_ROUTE_SUITES = [
  "server/src/__tests__/rt2-task-routes.test.ts",
  "server/src/__tests__/rt2-daily-report-routes.test.ts",
];

function pnpmCommandParts() {
  const pnpmExecPath = process.env.npm_execpath;
  if (pnpmExecPath) {
    return { command: process.execPath, prefixArgs: [pnpmExecPath] };
  }
  return { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", prefixArgs: [] };
}

function buildHostReadyCommands() {
  const { command, prefixArgs } = pnpmCommandParts();
  return [
    {
      label: "embedded-postgres-db",
      command,
      args: [...prefixArgs, "exec", "vitest", "run", "--project", "@paperclipai/db", ...DB_SUITES],
    },
    {
      label: "embedded-postgres-rt2-routes",
      command,
      args: [
        ...prefixArgs,
        "exec",
        "vitest",
        "run",
        "--project",
        "@paperclipai/server",
        ...SERVER_ROUTE_SUITES,
        "--pool=forks",
        "--poolOptions.forks.isolate=true",
      ],
    },
  ];
}

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    dryRun: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = path.resolve(argv[++i]);
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function createIsolatedEnv(root) {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-postgres-host-ready-"));
  return {
    ...process.env,
    PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS: "true",
    PAPERCLIP_SKIP_EMBEDDED_POSTGRES_TESTS: "false",
    PAPERCLIP_HOME: process.env.PAPERCLIP_HOME ?? path.join(runRoot, "home"),
    PAPERCLIP_INSTANCE_ID: process.env.PAPERCLIP_INSTANCE_ID ?? `embedded-postgres-host-ready-${process.pid}`,
    TMPDIR: process.env.TMPDIR ?? path.join(runRoot, "tmp"),
    RT2_EMBEDDED_POSTGRES_HOST_READY_ROOT: root,
  };
}

function printHelp() {
  console.log(`Usage: node scripts/rt2-embedded-postgres-host-ready.mjs [options]

Options:
  --root <path>   Repository root (default: cwd)
  --dry-run       Print focused commands without running embedded Postgres
  --json          Print JSON output
  --help          Show this help
`);
}

function printText(commands) {
  console.log("# RT2 Embedded Postgres Host-Ready Coverage");
  console.log("");
  for (const command of commands) {
    console.log(`${command.label}: ${[command.command, ...command.args].join(" ")}`);
  }
}

function runHostReadyCommands({ root, commands = buildHostReadyCommands() }) {
  const env = createIsolatedEnv(root);
  fs.mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  fs.mkdirSync(env.TMPDIR, { recursive: true });

  const results = [];
  for (const command of commands) {
    console.log(`\n[embedded-postgres] ${command.label}`);
    const result = spawnSync(command.command, command.args, {
      cwd: root,
      env,
      stdio: "inherit",
      windowsHide: true,
    });

    const status = result.error ? "error" : result.status === 0 ? "passed" : "failed";
    results.push({
      label: command.label,
      status,
      exitCode: result.status,
      error: result.error?.message ?? null,
    });

    if (status !== "passed") {
      return { status, results };
    }
  }

  return { status: "passed", results };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      return;
    }

    const commands = buildHostReadyCommands();
    if (args.dryRun) {
      if (args.json) {
        console.log(JSON.stringify({ status: "dry_run", commands }, null, 2));
      } else {
        printText(commands);
      }
      return;
    }

    const summary = runHostReadyCommands({ root: args.root, commands });
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    }
    process.exit(summary.status === "passed" ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("rt2-embedded-postgres-host-ready.mjs")
) {
  main();
}

export {
  DB_SUITES,
  SERVER_ROUTE_SUITES,
  buildHostReadyCommands,
  runHostReadyCommands,
};
