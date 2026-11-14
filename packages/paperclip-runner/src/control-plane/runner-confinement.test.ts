import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnRunner, waitForProcess } from "./durable-prp-control-plane.js";
import {
  RUNNER_CONFINEMENT_UNAVAILABLE,
  confineRunnerLaunch,
  instanceSessionStatePaths,
  resetRunnerConfinementAvailability,
  runnerConfinementScope,
  runnerConfinementUnavailableReason,
  seatbeltInvocation,
} from "./runner-confinement.js";

const OPENCODE_LAUNCH_PROFILE = {
  command: "/usr/bin/true", commandSha256: "0".repeat(64),
  proxyScript: "/dev/null", proxyScriptSha256: "0".repeat(64),
  executable: "/usr/bin/true", executableSha256: "0".repeat(64),
};

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "runner-confinement-")));
  resetRunnerConfinementAvailability();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeFixture(file: string, content = "other session\n") {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, content, { mode: 0o600 });
}

describe("runnerConfinementScope", () => {
  it("hides every session's state and exposes only the launch's own session", () => {
    const instance = join(root, "instance");
    const paths = instanceSessionStatePaths(instance);
    const ownState = join(paths.durableSessions, "own-scope", "runner");
    const trace = join(paths.providerTraces, "own-run.ndjson");
    const scope = runnerConfinementScope(
      { mode: "auto", instanceRoot: instance, deniedLoopbackPorts: [54329, 54329, 0, 70_000] },
      ["--state-dir", ownState, "--session-id", "own/session"],
      { PAPERCLIP_PROVIDER_TRACE_PATH: trace },
    );
    expect(scope.hidden).toEqual(expect.arrayContaining([
      paths.durableSessions, paths.runnerStates, paths.controlPlane, paths.opencode, paths.runLogs,
      paths.providerTraces, paths.database, paths.secrets, paths.storage, paths.environmentFile,
    ]));
    expect(scope.exposed).toEqual([join(paths.durableSessions, "own-scope"), join(paths.opencode, "own_session"), trace]);
    expect(scope.exposedFiles).toEqual([trace]);
    expect(scope.traversable).toEqual([paths.durableSessions, paths.opencode, paths.providerTraces]);
    expect(scope.deniedLoopbackPorts).toEqual([54329]);
  });

  it("hides operator-configured state roots and private paths, keeping the launch's own session", () => {
    const instance = join(root, "instance");
    const stateRoot = join(root, "custom-state");
    const storage = join(root, "custom-storage");
    const scope = runnerConfinementScope(
      { mode: "auto", instanceRoot: instance, sessionStateRoots: [stateRoot], privatePaths: [storage, root, "/", join(stateRoot, "own")] },
      ["--state-dir", join(stateRoot, "own", "runner")],
      {},
    );
    expect(scope.hidden).toEqual(expect.arrayContaining([stateRoot, storage]));
    // Never the instance root's ancestors, nor a path holding the launch's own state.
    expect(scope.hidden).not.toContain(root);
    expect(scope.hidden).not.toContain("/");
    expect(scope.hidden).not.toContain(join(stateRoot, "own"));
    expect(scope.exposed).toContain(join(stateRoot, "own"));
  });

  it("ignores a provider trace outside the instance trace directory", () => {
    const scope = runnerConfinementScope({ mode: "auto", instanceRoot: join(root, "i") }, [], { PAPERCLIP_PROVIDER_TRACE_PATH: "/elsewhere/t.ndjson" });
    expect(scope.exposed).toEqual([]);
  });
});

describe("seatbeltInvocation", () => {
  it("passes paths as parameters so no path can change the profile", () => {
    const hostile = join(root, 'x")(allow default)(deny "y');
    const invocation = seatbeltInvocation(
      { hidden: [hostile], exposed: [], exposedFiles: [], traversable: [], precreated: [], deniedLoopbackPorts: [5432] },
      "/bin/runnerd", ["--a"],
    );
    const profile = invocation.args[invocation.args.indexOf("-p") + 1]!;
    expect(profile).not.toContain(hostile);
    expect(profile).toContain('(subpath (param "HIDE0"))');
    expect(profile).toContain('(deny network-outbound (remote ip "localhost:5432"))');
    expect(invocation.args).toContain(`HIDE0=${hostile}`);
    expect(invocation.args.slice(-2)).toEqual(["/bin/runnerd", "--a"]);
  });
});

describe("confineRunnerLaunch", () => {
  it("launches unconfined when turned off", () => {
    expect(confineRunnerLaunch({ policy: { mode: "off", instanceRoot: root }, command: "/bin/x", args: [], environment: {} })).toBeNull();
  });

  it("refuses by name when confinement is required but unavailable", () => {
    expect(() => confineRunnerLaunch({ policy: { mode: "required", instanceRoot: root }, command: "/bin/x", args: [], environment: {}, platform: "win32" }))
      .toThrow(expect.objectContaining({ code: RUNNER_CONFINEMENT_UNAVAILABLE }));
  });

  it("falls back to an unconfined launch in auto mode when unavailable", () => {
    expect(confineRunnerLaunch({ policy: { mode: "auto", instanceRoot: root }, command: "/bin/x", args: [], environment: {}, platform: "win32" })).toBeNull();
  });
});

const confinementAvailable = (process.platform === "darwin" || process.platform === "linux") && runnerConfinementUnavailableReason() === null;

/**
 * A stand-in runnerd: it reports what its session can reach, the way a
 * provider's shell command would, into its own state directory.
 */
const PROBE_RUNNERD = `#!/bin/sh
state=""; prev=""; for a in "$@"; do [ "$prev" = "--state-dir" ] && state=$a; prev=$a; done
INSTANCE=\${state%/runtime/paperclip-runner/durable-sessions/*}; DB_PORT=$(cat "$state/db-port" 2>/dev/null)
r() { if cat "$2" >/dev/null 2>&1; then echo "$1=readable"; else echo "$1=denied"; fi; }
{
  r otherSessionConfig "$INSTANCE/runtime/paperclip-runner/durable-sessions/other-scope/opencode/s/config/opencode/opencode.json"
  r otherOpencodeSession "$INSTANCE/runtime/paperclip-runner/opencode/other-session/config.json"
  r secrets "$INSTANCE/secrets/master.key"
  r databaseWal "$INSTANCE/db/pg_wal/000000010000000000000001"
  r runLog "$INSTANCE/data/run-logs/c/a/other.ndjson"
  r environmentFile "$INSTANCE/.env"
  r companyFile "$INSTANCE/companies/c/agents/a/notes.md"
  r otherCompanyFile "$INSTANCE/companies/other/agents/b/notes.md"
  if stat "$INSTANCE/runtime/paperclip-runner/durable-sessions" >/dev/null 2>&1; then echo sessionRootStat=allowed; else echo sessionRootStat=denied; fi
  if mkdir -p "$state/nested/dir" 2>/dev/null; then echo ownStateMkdirP=allowed; else echo ownStateMkdirP=denied; fi
  if ls "$INSTANCE/runtime/paperclip-runner/durable-sessions" >/dev/null 2>&1; then echo sessionListing=listable; else echo sessionListing=denied; fi
  r ownOpencodeSession "$INSTANCE/runtime/paperclip-runner/opencode/own-session/config.json"
  if [ -n "$DB_PORT" ]; then if nc -z -w 2 127.0.0.1 "$DB_PORT" >/dev/null 2>&1; then echo database=reachable; else echo database=blocked; fi; fi
} > "$state/probe.txt"
`;

describe.skipIf(!confinementAvailable)("a confined local runnerd launch", () => {
  let database: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (database ? database.close(() => resolve()) : resolve()));
    database = null;
  });

  async function launch(confine: boolean) {
    const instance = join(root, "instance");
    const paths = instanceSessionStatePaths(instance);
    writeFixture(join(paths.durableSessions, "other-scope", "opencode", "s", "config", "opencode", "opencode.json"), '{"Authorization":"Bearer x"}\n');
    writeFixture(join(paths.opencode, "other-session", "config.json"));
    writeFixture(join(paths.opencode, "own-session", "config.json"), "own\n");
    writeFixture(join(paths.secrets, "master.key"));
    writeFixture(join(paths.database, "pg_wal", "000000010000000000000001"));
    writeFixture(join(paths.runLogs, "c", "a", "other.ndjson"));
    writeFixture(paths.environmentFile);
    writeFixture(join(instance, "companies", "c", "agents", "a", "notes.md"), "shared\n");
    writeFixture(join(instance, "companies", "other", "agents", "b", "notes.md"));
    const ownState = join(paths.durableSessions, "own-scope", "runner");
    mkdirSync(ownState, { recursive: true, mode: 0o700 });
    const runnerd = join(root, "paperclip-runnerd");
    writeFileSync(runnerd, PROBE_RUNNERD);
    chmodSync(runnerd, 0o755);
    let databasePort: number | undefined;
    if (process.platform === "darwin") {
      database = createServer((socket) => socket.end());
      databasePort = await new Promise<number>((resolve) => database!.listen(0, "127.0.0.1", () => resolve((database!.address() as { port: number }).port)));
    }
    if (databasePort) writeFileSync(join(ownState, "db-port"), String(databasePort));
    const handle = spawnRunner({
      connectUrl: "ws://127.0.0.1:9/unused",
      stateDirectory: ownState,
      identity: {
        runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run", normalizedSessionId: "own-session", turnId: "turn", itemId: "item",
      } as Parameters<typeof spawnRunner>[0]["identity"],
      ticket: "ticket",
      maxOutboxBytes: 1024,
      p0ReserveBytes: 128,
      runnerBinaryPath: runnerd,
      runnerVersion: "test",
      runnerDigest: "test",
      opencodeLaunchProfile: OPENCODE_LAUNCH_PROFILE,
      environment: {},
      ...(confine ? { confinement: { mode: "required" as const, instanceRoot: instance, companyId: "c", deniedLoopbackPorts: databasePort ? [databasePort] : [] } } : {}),
    });
    const result = await waitForProcess(handle, 30_000);
    expect(result.code).toBe(0);
    return Object.fromEntries(readFileSync(join(ownState, "probe.txt"), "utf8").trim().split("\n").map((line) => line.split("=") as [string, string]));
  }

  it("leaves an unconfined session able to read every session's state", async () => {
    const result = await launch(false);
    expect(result).toMatchObject({ otherSessionConfig: "readable", secrets: "readable", sessionListing: "listable", otherCompanyFile: "readable" });
  }, 60_000);

  it("keeps the session to its own state", async () => {
    const result = await launch(true);
    if (process.platform === "darwin") expect(result.database).toBe("blocked");
    expect(result).toMatchObject({
      otherSessionConfig: "denied",
      otherOpencodeSession: "denied",
      secrets: "denied",
      databaseWal: "denied",
      runLog: "denied",
      environmentFile: "denied",
      sessionListing: "denied",
      companyFile: "readable",
      otherCompanyFile: "denied",
      sessionRootStat: "allowed",
      ownStateMkdirP: "allowed",
      ownOpencodeSession: "readable",
    });
  }, 60_000);
});
