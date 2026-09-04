import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRemoteEnvFileContent,
  buildSshEnvLabFixtureConfig,
  buildSshSpawnTarget,
  getSshEnvLabSupport,
  remoteEnvFilePathExpr,
  runSshCommand,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvLabFixtureState,
} from "./ssh.js";

const SSH_FIXTURE_TEST_TIMEOUT_MS = 30_000;

// A value chosen to break every naive quoting scheme at once: a single quote
// (which ends a shell single-quoted string), a double quote, a `$` expansion, a
// backtick substitution, a backslash, and a newline. If the transport ever goes
// back to splicing values into a command line, one of these characters shows up
// as syntax rather than data.
const HOSTILE_SECRET = `s3cr3t'";$(id)\`whoami\`\\end\nsecond-line`;

interface FixtureHandle {
  rootDir: string;
  state: SshEnvLabFixtureState | null;
}

const fixtures: FixtureHandle[] = [];

/**
 * Start a throwaway sshd, or return null when this machine cannot host one.
 * The fixture needs `sshd`, which is absent from slim container images, so the
 * end-to-end assertions below stay opt-in the same way `ssh-fixture.test.ts`
 * does it. The offline assertions in this file always run.
 */
async function startFixtureOrSkip(label: string): Promise<SshEnvLabFixtureState | null> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-remote-env-"));
  const handle: FixtureHandle = { rootDir, state: null };
  fixtures.push(handle);

  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    console.warn(`Skipping ${label}: ${support.reason}`);
    return null;
  }
  try {
    const state = await startSshEnvLabFixture({ statePath: path.join(rootDir, "state.json") });
    handle.state = state;
    return state;
  } catch (error) {
    console.warn(`Skipping ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function drainFixtures(): Promise<void> {
  while (fixtures.length > 0) {
    const handle = fixtures.pop();
    if (!handle) continue;
    if (handle.state) {
      try {
        await stopSshEnvLabFixture(handle.state);
      } catch (error) {
        // Keep the root directory so a later stop can still find the listener
        // through the state file, and never rethrow: a throw here would strand
        // the entries still on the stack.
        console.error(`SSH fixture teardown failed for pid ${handle.state.pid}:`, error);
        continue;
      }
    }
    await rm(handle.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Run a prepared spawn target to completion and collect its output. */
async function runSpawnTarget(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", () => resolve({ stdout, stderr }));
  });
}

describe("ssh remote environment delivery (REVIP-3492)", () => {
  afterEach(drainFixtures);

  it("writes every value as a shell-quoted export and deletes the file as it is read", () => {
    const pathExpr = remoteEnvFilePathExpr("11111111-2222-3333-4444-555555555555");
    const content = buildRemoteEnvFileContent(
      [["PAPERCLIP_API_KEY", HOSTILE_SECRET], ["SECOND", "plain"]],
      pathExpr,
    );

    const lines = content.split("\n");
    // A single-quoted body with the embedded quote escaped as '"'"'. Nothing in
    // the value can terminate the quoting and become shell syntax.
    expect(lines[0]).toBe(
      `export PAPERCLIP_API_KEY='s3cr3t'"'"'";$(id)\`whoami\`\\end`,
    );
    expect(lines[1]).toBe(`second-line'`);
    expect(lines[2]).toBe("export SECOND='plain'");
    // The file removes itself while being sourced, so a run that is killed
    // later still leaves no secret on the remote disk.
    expect(lines[3]).toBe(`rm -f "$HOME/.paperclip-run-env/11111111-2222-3333-4444-555555555555.env"`);
    // Trailing newline: `.` on a file whose last line lacks one is unspecified.
    expect(content.endsWith("\n")).toBe(true);
  });

  it("keeps the environment file inside the 0700 per-user directory", () => {
    expect(remoteEnvFilePathExpr("abc")).toBe(`"$HOME/.paperclip-run-env/abc.env"`);
  });

  // The transport-independent half of the fix: whatever ssh delivers, the
  // wrapper on the far side has to turn that file back into the exact values.
  // This runs the real remote-script shape under a real /bin/sh with $HOME
  // redirected, so it covers the quoting and the self-delete on every machine,
  // including the container images that cannot host the sshd fixture.
  it("sources the generated file under a real shell, exporting exact values and removing itself", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-env-home-"));
    fixtures.push({ rootDir: home, state: null });
    const id = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
    const pathExpr = remoteEnvFilePathExpr(id);
    const filePath = path.join(home, ".paperclip-run-env", `${id}.env`);

    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, buildRemoteEnvFileContent([["PAPERCLIP_API_KEY", HOSTILE_SECRET]], pathExpr), {
      mode: 0o600,
    });

    // The same `. <file> && exec sh -c <command>` chain the ssh wrapper builds.
    const script = `. ${pathExpr} && exec sh -c 'printf %s "$PAPERCLIP_API_KEY"'`;
    const result = await new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
      const child = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "inherit"], env: { HOME: home, PATH: process.env.PATH ?? "" } });
      let stdout = "";
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.once("error", reject);
      child.once("close", (code) => resolve({ stdout, code }));
    });

    expect(result.code).toBe(0);
    // Byte-for-byte, including the embedded quotes, `$(id)`, backticks and the
    // newline: nothing was expanded, split, or truncated on the way through.
    expect(result.stdout).toBe(HOSTILE_SECRET);
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when the environment file is missing instead of running without secrets", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-env-home-"));
    fixtures.push({ rootDir: home, state: null });
    const script = `. ${remoteEnvFilePathExpr("does-not-exist")} && exec sh -c 'echo RAN'`;
    const result = await new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
      const child = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "ignore"], env: { HOME: home, PATH: process.env.PATH ?? "" } });
      let stdout = "";
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.once("error", reject);
      child.once("close", (code) => resolve({ stdout, code }));
    });

    // A run must never start with a half-populated environment: no API key is a
    // failed run, not a run that silently talks to the wrong place.
    expect(result.stdout).not.toContain("RAN");
    expect(result.code).not.toBe(0);
  });

  it("never places an environment value in the ssh argument vector", async () => {
    const started = await startFixtureOrSkip("ssh argv secrecy test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);

    const target = await buildSshSpawnTarget({
      spec: { ...config, remoteCwd: started.workspaceDir },
      command: "sh",
      args: ["-c", 'printf %s "$PAPERCLIP_API_KEY"'],
      env: { PAPERCLIP_API_KEY: HOSTILE_SECRET },
    });

    try {
      // The finding in REVIP-3492 was that `ps -eo cmd` showed these values.
      // argv is what /proc/<pid>/cmdline exposes, so assert on the whole vector.
      const argv = [target.command, ...target.args].join(" ");
      expect(argv).not.toContain(HOSTILE_SECRET);
      expect(argv).not.toContain("s3cr3t");
      expect(argv).not.toContain("exec env ");

      // ...and the command still receives the value.
      const result = await runSpawnTarget(target.command, target.args);
      expect(result.stdout).toBe(HOSTILE_SECRET);
    } finally {
      await target.cleanup();
    }
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("delivers the environment to runSshCommand and leaves no file behind", async () => {
    const started = await startFixtureOrSkip("ssh env delivery test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);

    const result = await runSshCommand(config, 'printf %s "$PAPERCLIP_API_KEY"', {
      env: { PAPERCLIP_API_KEY: HOSTILE_SECRET },
    });
    expect(result.stdout).toBe(HOSTILE_SECRET);

    // The wrapper sources the file, which removes itself in the same step, so
    // the directory is empty once the run returns.
    const leftovers = await runSshCommand(
      config,
      'ls -A "$HOME/.paperclip-run-env" 2>/dev/null | wc -l',
    );
    expect(leftovers.stdout.trim()).toBe("0");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("rejects an invalid environment key before opening a connection", async () => {
    await expect(
      buildSshSpawnTarget({
        spec: {
          host: "127.0.0.1",
          port: 1,
          username: "nobody",
          remoteWorkspacePath: "/tmp",
          remoteCwd: "/tmp",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: false,
        },
        command: "true",
        args: [],
        env: { "BAD KEY": "value" },
      }),
    ).rejects.toThrow(/Invalid SSH environment variable key/);
  });
});
