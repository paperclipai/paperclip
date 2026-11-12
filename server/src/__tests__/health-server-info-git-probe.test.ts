import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { ServerGitInfo } from "@paperclipai/shared";

const BUILD_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const POLL_INTERVAL_MS = 5000;

// Git itself is real in this file. The mock only counts the git processes that
// the server starts, so a test also fails when real Git disagrees with the
// server about where a checkout is.
const serverGit = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  serverGit.execFileSync.mockImplementation((...args: unknown[]) =>
    (actual.execFileSync as (...values: unknown[]) => unknown)(...args));
  return { ...actual, execFileSync: serverGit.execFileSync };
});

const { healthRoutes } = await import("../routes/health.js");
const { livenessRoutes } = await import("../routes/liveness.js");
const { getServerProcessStartedAt, resetServerInfoCacheForTests } = await import("../server-info.js");
const { resetStartupRecoveryStateForTests, setStartupRecoveryPhase } = await import("../startup-recovery-state.js");

type HealthOptions = NonNullable<Parameters<typeof healthRoutes>[1]>;

// The options that server/src/app.ts passes: no `serverInfo`.
const productionHealthOptions: HealthOptions = {
  deploymentMode: "authenticated",
  deploymentExposure: "private",
  authReady: true,
  companyDeletionEnabled: false,
  isWarmStandby: () => false,
};

function serverGitStarts(): number {
  return serverGit.execFileSync.mock.calls.filter(([command]) => command === "git").length;
}

/** Runs real Git for the test fixture. The server's own starts are not counted here. */
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  return { status: result.status, stdout: result.stdout.trim() };
}

function commit(checkout: string, subject: string): string {
  fs.writeFileSync(path.join(checkout, "file.txt"), `${subject}\n`);
  expect(git(checkout, "add", "file.txt").status).toBe(0);
  expect(git(checkout, "commit", "--quiet", "--message", subject).status).toBe(0);
  return git(checkout, "rev-parse", "HEAD").stdout;
}

function createCheckout(): string {
  const checkout = path.join(home, "checkout");
  fs.mkdirSync(path.join(checkout, "server"), { recursive: true });
  expect(git(checkout, "init", "--quiet", "--initial-branch=main").status).toBe(0);
  return checkout;
}

function stubDatabase(): Db {
  const rows = (value: unknown[]) => Object.assign(Promise.resolve(value), { groupBy: () => Promise.resolve([]) });
  return {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    select: () => ({ from: () => ({ where: () => rows([{ count: 1 }]) }) }),
  } as unknown as Db;
}

function createServer(serverInfo?: HealthOptions["serverInfo"]) {
  const app = express();
  app.use((req, _res, next) => {
    if (req.get("x-test-actor") === "board") {
      (req as unknown as { actor: { type: string } }).actor = { type: "board" };
    }
    next();
  });
  app.use("/api/liveness", serverInfo ? livenessRoutes(serverInfo) : livenessRoutes());
  app.use("/api/health", healthRoutes(stubDatabase(), { ...productionHealthOptions, ...(serverInfo ? { serverInfo } : {}) }));
  return app;
}

/** Each poll is one cache lifetime after the previous one, as real polls are. */
async function poll(app: express.Express, polls = 1) {
  const responses: Array<{ anonymous: string; board: string; liveness: string }> = [];
  for (let index = 0; index < polls; index += 1) {
    vi.setSystemTime(Date.now() + POLL_INTERVAL_MS);
    const anonymous = await request(app).get("/api/health").expect(200);
    const board = await request(app).get("/api/health").set("x-test-actor", "board").expect(200);
    const liveness = await request(app).get("/api/liveness").expect(200);
    responses.push({ anonymous: anonymous.text, board: board.text, liveness: liveness.text });
  }
  return responses;
}

const originalDirectory = process.cwd();
let home: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-git-probe-")));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GIT_") || name.startsWith("PAPERCLIP_CLOUD_")) vi.stubEnv(name, undefined);
  }
  vi.stubEnv("PAPERCLIP_BUILD_COMMIT", undefined);
  vi.useFakeTimers({ toFake: ["Date"] });
  serverGit.execFileSync.mockClear();
  resetServerInfoCacheForTests();
  setStartupRecoveryPhase("ready");
});

afterEach(() => {
  process.chdir(originalDirectory);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetServerInfoCacheForTests();
  resetStartupRecoveryStateForTests();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("git processes behind health and liveness requests", () => {
  it("starts no git process when the server does not run from a checkout", async () => {
    const install = path.join(home, "app");
    fs.mkdirSync(install);
    process.chdir(install);
    vi.stubEnv("PAPERCLIP_BUILD_COMMIT", BUILD_COMMIT);
    // The assumption behind the fix: here real Git can only fail.
    expect(git(install, "show", "-s", "--format=%H", "HEAD").status).not.toBe(0);
    const buildGitInfo: ServerGitInfo = {
      available: true,
      fullSha: BUILD_COMMIT,
      shortSha: BUILD_COMMIT.slice(0, 7),
      branchName: null,
      subject: "Source build",
      committedAt: null,
      localChanges: { available: false, unavailableReason: "git_status_unavailable" },
    };

    const responses = await poll(createServer(), 5);

    // The reference server gets the snapshot injected, so it never reads Git.
    const [reference] = await poll(createServer({ processStartedAt: getServerProcessStartedAt(), git: buildGitInfo }));
    for (const response of responses) expect(response).toEqual(reference);
    expect(JSON.parse(reference!.anonymous)).toMatchObject({ status: "ok", commit: BUILD_COMMIT });
    expect(JSON.parse(reference!.anonymous).serverInfo).toBeUndefined();
    expect(JSON.parse(reference!.board).serverInfo).toEqual({
      processStartedAt: getServerProcessStartedAt(),
      git: buildGitInfo,
    });
    expect(JSON.parse(reference!.liveness)).toEqual({ status: "ok", commit: BUILD_COMMIT });
    expect(serverGitStarts()).toBe(0);
  });

  it("reads a checkout again after its commit changes, also from a subdirectory", async () => {
    const checkout = createCheckout();
    const firstCommit = commit(checkout, "First commit");
    process.chdir(path.join(checkout, "server"));
    const app = createServer();

    const [first] = await poll(app);
    expect(JSON.parse(first!.board).serverInfo.git).toMatchObject({
      fullSha: firstCommit,
      branchName: "main",
      subject: "First commit",
      localChanges: { available: true, hasLocalChanges: false },
    });

    const secondCommit = commit(checkout, "Second commit");
    const [second] = await poll(app);
    expect(JSON.parse(second!.anonymous).commit).toBe(secondCommit);
    expect(JSON.parse(second!.board).serverInfo).toMatchObject({
      processStartedAt: getServerProcessStartedAt(),
      git: { fullSha: secondCommit, subject: "Second commit" },
    });
    // Liveness keeps the commit that it read when the routes were created.
    expect(JSON.parse(second!.liveness)).toEqual({ status: "ok", commit: firstCommit });
  });

  it("reads a linked worktree, where .git is a file", async () => {
    const checkout = createCheckout();
    commit(checkout, "First commit");
    const worktree = path.join(home, "worktree");
    expect(git(checkout, "worktree", "add", "--quiet", "-b", "feature", worktree).status).toBe(0);
    const worktreeCommit = commit(worktree, "Worktree commit");
    expect(fs.statSync(path.join(worktree, ".git")).isFile()).toBe(true);
    process.chdir(worktree);

    const [response] = await poll(createServer());

    expect(JSON.parse(response!.board).serverInfo.git).toMatchObject({
      fullSha: worktreeCommit,
      branchName: "feature",
      subject: "Worktree commit",
    });
  });

  it("still asks git when GIT_DIR names a repository outside the working directory", async () => {
    const checkout = createCheckout();
    const headCommit = commit(checkout, "Commit found through GIT_DIR");
    const install = path.join(home, "app");
    fs.mkdirSync(install);
    process.chdir(install);
    vi.stubEnv("GIT_DIR", path.join(checkout, ".git"));

    const [response] = await poll(createServer());

    expect(JSON.parse(response!.anonymous).commit).toBe(headCommit);
    expect(serverGitStarts()).toBeGreaterThan(0);
  });
});
