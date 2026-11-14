import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { Db } from "@paperclipai/db";

const argument = (name: string) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const requests = Number(argument("--requests") ?? 200);
const pollIntervalMs = Number(argument("--poll-interval-ms") ?? 5000);
assert.ok(Number.isInteger(requests) && requests >= 2 && requests <= 100_000, "--requests must be an integer from 2 to 100000");
assert.ok(Number.isInteger(pollIntervalMs) && pollIntervalMs >= 1, "--poll-interval-ms must be a positive integer");
assert.notEqual(process.platform, "win32", "the counting git stand-in needs a POSIX shell");

const BUILD_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const COMMIT_SUBJECT = "Benchmark checkout commit";
const COMMIT_DATE = "2026-11-12T00:00:00Z";

const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paperclip-health-server-info-benchmark-")));
const execLogPath = path.join(home, "git-execs.log");
const binDir = path.join(home, "bin");
const packagedDir = path.join(home, "packaged-install");
const checkoutDir = path.join(home, "source-checkout");

const gitExecs = () => existsSync(execLogPath) ? readFileSync(execLogPath, "utf8").split("\n").filter(Boolean).length : 0;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

function isolateEnvironment() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("PAPERCLIP_") || name.startsWith("GIT_")) delete process.env[name];
  }
  process.env.PAPERCLIP_HOME = home;
  process.env.PAPERCLIP_INSTANCE_ID = "default";
  process.env.PAPERCLIP_LOG_LEVEL = "silent";
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
}

function createCheckout(): string {
  mkdirSync(checkoutDir);
  const git = (...args: string[]) => execFileSync(realGit, args, {
    cwd: checkoutDir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Benchmark",
      GIT_AUTHOR_EMAIL: "benchmark@example.com",
      GIT_AUTHOR_DATE: COMMIT_DATE,
      GIT_COMMITTER_NAME: "Benchmark",
      GIT_COMMITTER_EMAIL: "benchmark@example.com",
      GIT_COMMITTER_DATE: COMMIT_DATE,
    },
  }).trim();
  git("init", "--quiet", "--initial-branch=benchmark");
  writeFileSync(path.join(checkoutDir, "README.md"), "benchmark\n");
  git("add", "README.md");
  git("commit", "--quiet", "--message", COMMIT_SUBJECT);
  return git("rev-parse", "HEAD");
}

function stubDatabase(): Db {
  const rows = (value: unknown[]) => Object.assign(Promise.resolve(value), { groupBy: () => Promise.resolve([]) });
  return {
    execute: async () => [{ "?column?": 1 }],
    select: () => ({ from: () => ({ where: () => rows([{ count: 1 }]) }) }),
  } as unknown as Db;
}

try {
  isolateEnvironment();
  mkdirSync(binDir);
  mkdirSync(packagedDir);
  const checkoutCommit = createCheckout();
  const standIn = path.join(binDir, "git");
  writeFileSync(standIn, `#!/bin/sh\necho exec >> '${execLogPath}'\nexec '${realGit}' "$@"\n`);
  chmodSync(standIn, 0o755);

  const { healthRoutes } = await import("../src/routes/health.js");
  const { livenessRoutes } = await import("../src/routes/liveness.js");
  const { resetServerInfoCacheForTests } = await import("../src/server-info.js");
  const { setStartupRecoveryPhase } = await import("../src/startup-recovery-state.js");
  isolateEnvironment();
  setStartupRecoveryPhase("ready");

  const realNow = Date.now;
  let clockOffsetMs = 0;
  Date.now = () => realNow() + clockOffsetMs;

  const scenarios = [
    {
      name: "packaged install: no checkout, build supplies the commit",
      directory: packagedDir,
      buildCommit: BUILD_COMMIT,
      expectedGit: {
        available: true,
        fullSha: BUILD_COMMIT,
        shortSha: BUILD_COMMIT.slice(0, 7),
        branchName: null,
        subject: "Source build",
        committedAt: null,
        localChanges: { available: false, unavailableReason: "git_status_unavailable" },
      },
    },
    {
      name: "source checkout",
      directory: checkoutDir,
      buildCommit: undefined,
      expectedGit: {
        available: true,
        fullSha: checkoutCommit,
        shortSha: checkoutCommit.slice(0, 7),
        branchName: "benchmark",
        subject: COMMIT_SUBJECT,
        committedAt: new Date(COMMIT_DATE).toISOString(),
        localChanges: { available: true, hasLocalChanges: false, stagedFileCount: 0, unstagedFileCount: 0, untrackedFileCount: 0 },
      },
    },
  ];
  const patterns = [
    { name: "burst", advanceMs: 0 },
    { name: `polled every ${pollIntervalMs} ms`, advanceMs: pollIntervalMs },
  ];
  const rows: Array<Record<string, string | number>> = [];

  for (const scenario of scenarios) {
    process.chdir(scenario.directory);
    if (scenario.buildCommit) process.env.PAPERCLIP_BUILD_COMMIT = scenario.buildCommit;
    else delete process.env.PAPERCLIP_BUILD_COMMIT;

    for (const pattern of patterns) {
      resetServerInfoCacheForTests();
      const execsBeforeRoutes = gitExecs();
      const app = express();
      app.use((req, _res, next) => {
        if (req.get("x-benchmark-actor") === "board") {
          (req as unknown as { actor: { type: string } }).actor = { type: "board" };
        }
        next();
      });
      app.use("/api/liveness", livenessRoutes());
      app.use("/api/health", healthRoutes(stubDatabase(), {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        authReady: true,
        companyDeletionEnabled: false,
        isWarmStandby: () => false,
      }));
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const routeExecs = gitExecs() - execsBeforeRoutes;

      const bodies = { anonymous: new Set<string>(), board: new Set<string>(), liveness: new Set<string>() };
      const execsBeforeRequests = gitExecs();
      const started = process.hrtime.bigint();
      for (let index = 0; index < requests; index += 1) {
        clockOffsetMs += pattern.advanceMs;
        const board = index % 2 === 1;
        const response = await fetch(`${origin}/api/health`, board ? { headers: { "x-benchmark-actor": "board" } } : undefined);
        const text = await response.text();
        assert.equal(response.status, 200, `${scenario.name}: health status`);
        const body = JSON.parse(text);
        assert.equal(body.commit, scenario.expectedGit.fullSha, `${scenario.name}: commit`);
        if (board) {
          assert.deepEqual(body.serverInfo.git, scenario.expectedGit, `${scenario.name}: serverInfo.git`);
          assert.equal(new Date(body.serverInfo.processStartedAt).toISOString(), body.serverInfo.processStartedAt);
          bodies.board.add(JSON.stringify({ commit: body.commit, serverInfo: body.serverInfo }));
        } else {
          assert.equal(body.serverInfo, undefined, `${scenario.name}: anonymous response carries no serverInfo`);
          bodies.anonymous.add(text);
        }
      }
      const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
      const requestExecs = gitExecs() - execsBeforeRequests;

      const liveness = await fetch(`${origin}/api/liveness`);
      const livenessText = await liveness.text();
      assert.equal(liveness.status, 200, `${scenario.name}: liveness status`);
      assert.deepEqual(JSON.parse(livenessText), { status: "ok", commit: scenario.expectedGit.fullSha });
      bodies.liveness.add(livenessText);
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });

      assert.equal(bodies.anonymous.size, 1, `${scenario.name}: anonymous health body is stable`);
      assert.equal(bodies.board.size, 1, `${scenario.name}: board health serverInfo is stable`);
      rows.push({
        scenario: scenario.name,
        pattern: pattern.name,
        "health requests": requests,
        "git execs at route creation": routeExecs,
        "git execs for requests": requestExecs,
        "ms per request": Number((totalMs / requests).toFixed(3)),
        "body sha256 (anonymous / board commit+serverInfo.git / liveness)": [
          sha256([...bodies.anonymous][0]!),
          sha256(JSON.stringify(JSON.parse([...bodies.board][0]!).serverInfo.git)),
          sha256(livenessText),
        ].join(" / "),
      });
    }
  }
  Date.now = realNow;
  console.table(rows);
  console.log(`node ${process.version}, ${os.platform()} ${os.arch()}, rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
} finally {
  process.chdir(os.tmpdir());
  rmSync(home, { recursive: true, force: true });
}
