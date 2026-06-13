#!/usr/bin/env -S node --import tsx
import { bootstrapDevRunnerWorktreeEnv } from "../server/src/dev-runner-worktree.ts";
import {
  isPidAlive,
  listLocalServiceRegistryRecords,
  readLocalServicePortOwner,
} from "../server/src/services/local-service-supervisor.ts";
import {
  buildDevStatus,
  findDevConfigFilePath,
  probeEmbeddedPg,
  readDevConfig,
  type DevStatusReport,
} from "../server/src/dev-status-utils.ts";
import { repoRoot } from "./dev-service-profile.ts";

bootstrapDevRunnerWorktreeEnv(repoRoot, process.env);

async function run(): Promise<DevStatusReport> {
  const configPath = findDevConfigFilePath(repoRoot);
  const config = readDevConfig(configPath);
  const apiPort = Number(process.env.PORT || config.port);

  const records = await listLocalServiceRegistryRecords({
    profileKind: "paperclip-dev",
    metadata: { repoRoot },
  });

  const apiPortOwner = await readLocalServicePortOwner(apiPort);
  const pg = await probeEmbeddedPg(config.pgDataDir, config.pgPort);

  return buildDevStatus(repoRoot, records, config, apiPort, apiPortOwner, pg);
}

function printHumanStatus(s: DevStatusReport): void {
  const col = (label: string, value: string) => `  ${label.padEnd(16)} ${value}`;
  const sep = "─".repeat(60);

  console.log(`\nPaperclip dev status — ${s.repoRoot}`);
  console.log(sep);
  console.log(col("mode", s.devMode));
  console.log(col("url", s.apiUrl));
  console.log("");

  const label = s.devRunner.mode === "watch" || !s.devRunner.found ? "dev watcher" : "dev runner";
  let watcherLine: string;
  if (!s.devRunner.found) {
    watcherLine = "not found";
  } else if (s.devRunner.alive) {
    const child = s.devRunner.childPid ? `  child=${s.devRunner.childPid}` : "";
    watcherLine = `running   pid=${s.devRunner.pid}${child}  up ${s.devRunner.uptime}`;
  } else {
    watcherLine = `DEAD      pid=${s.devRunner.pid} (not responding)`;
  }
  console.log(col(label, watcherLine));

  let serverLine: string;
  if (s.devRunner.childPid !== null && isPidAlive(s.devRunner.childPid)) {
    serverLine = `running   pid=${s.devRunner.childPid}`;
  } else if (s.apiPortOwner !== null) {
    serverLine = `unknown   pid=${s.apiPortOwner} (port ${s.apiPort} bound)`;
  } else {
    serverLine = "not running";
  }
  console.log(col("api + ui", serverLine));

  const pgLine = s.pg.alive
    ? `running   pid=${s.pg.pid}  port=${s.pg.port}`
    : `not running  port=${s.pg.port}`;
  console.log(col("embedded pg", pgLine));

  console.log(sep);

  if (s.devRunner.alive) {
    console.log(`  Open: ${s.apiUrl}`);
  }

  if (s.recommendations.length > 0) {
    console.log("");
    for (const rec of s.recommendations) {
      console.log(`  → ${rec}`);
    }
  }

  console.log("");
}

const isJson = process.argv.includes("--json");
const status = await run();

if (isJson) {
  console.log(JSON.stringify(status, null, 2));
} else {
  printHumanStatus(status);
}
