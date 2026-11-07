import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPruneSshRunSessionRecordsScript,
  buildSshEnvLabFixtureConfig,
  buildSshSpawnTarget,
  buildStopSshRunSessionsScript,
  ensureSshWorkspaceReady,
  getSshEnvLabSupport,
  parseSshRunSessionStopStatus,
  runSshCommand,
  shellQuote,
  sshRunSessionRecordDir,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvLabFixtureState,
} from "./ssh.js";

const spec = {
  host: "ssh.example.test",
  port: 22,
  username: "ssh-user",
  remoteCwd: "/srv/paperclip/workspace",
  remoteWorkspacePath: "/srv/paperclip/workspace",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: true,
};

const RUN_ID = "4f17d9d6-a124-4432-9040-a93d53d1e9f2";
const OTHER_RUN_ID = "0b6f9a51-5d0e-4f3e-9d43-2f0c8f1e7a10";

// The stop script waits 10 s between TERM and KILL; the tests wait 1 s.
function stopScript(runId: string, procRoot = "/proc") {
  return buildStopSshRunSessionsScript(runId).replace(/^wait=10$/m, "wait=1").replaceAll("/proc", procRoot);
}

// Runs a script in a new session, as sshd runs the stop.
function runSh(script: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", script], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

// Fields of /proc/<pid>/stat after the command name: [state, ppid, pgrp, session, ...].
function statFields(pid: number) {
  return readFileSync(`/proc/${pid}/stat`, "utf8").split(")").at(-1)!.trim().split(" ");
}

function isRunning(pid: number) {
  try {
    const state = statFields(pid)[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Runs the stop against a fake /proc that holds the stopping shell's own entry
// (linked in before the script starts, under the same pid) and, unless
// `withInit` is false, pid 1.
async function runInFakeProc(script: string, fakeProc: string, env: NodeJS.ProcessEnv, withInit = true) {
  if (withInit) await symlink("/proc/1", path.join(fakeProc, "1"));
  return runSh(`ln -s /proc/$$ ${fakeProc}/$$ && exec sh -c ${shellQuote(script)}`, env);
}

// The session start time of a live pid, as the spawn records it.
function startTimeOf(pid: number) {
  return statFields(pid)[19]!;
}

async function readPids(file: string, count: number) {
  await until(async () => (await readFile(file, "utf8").catch(() => "")).trim().split(/\s+/).filter(Boolean).length >= count);
  return (await readFile(file, "utf8")).trim().split(/\s+/).map(Number);
}

describe("SSH run session tracking", () => {
  it("records the session before exec when the spawn carries a run id", async () => {
    const target = await buildSshSpawnTarget({
      spec,
      command: "claude",
      args: ["--print"],
      env: { PAPERCLIP_RUN_ID: RUN_ID },
    });
    const remoteScript = String(target.args.at(-1) ?? "");
    const record = remoteScript.indexOf(`.paperclip/run-sessions/${RUN_ID}`);
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(remoteScript.indexOf("exec env "));
    expect(remoteScript).toContain("/proc/$$/stat");
    await target.cleanup();
  });

  it("records the session under the explicit run id, without PAPERCLIP_RUN_ID in the env", async () => {
    const target = await buildSshSpawnTarget({ spec, command: "node", args: [], env: { FOO: "bar" }, runId: RUN_ID });
    expect(String(target.args.at(-1) ?? "")).toContain(`.paperclip/run-sessions/${RUN_ID}`);
    await target.cleanup();
    const both = await buildSshSpawnTarget({
      spec, command: "node", args: [], env: { PAPERCLIP_RUN_ID: OTHER_RUN_ID }, runId: RUN_ID,
    });
    const script = String(both.args.at(-1) ?? "");
    expect(script).toContain(`.paperclip/run-sessions/${RUN_ID}`);
    expect(script).not.toContain(`.paperclip/run-sessions/${OTHER_RUN_ID}`);
    await both.cleanup();
  });

  it("records nothing without a run id, or for a run id unsafe in a path", async () => {
    const envs: Record<string, string>[] = [{ FOO: "bar" }, { PAPERCLIP_RUN_ID: "../escape" }];
    for (const env of envs) {
      const target = await buildSshSpawnTarget({ spec, command: "node", args: [], env });
      expect(String(target.args.at(-1) ?? "")).not.toContain("run-sessions");
      await target.cleanup();
    }
    expect(sshRunSessionRecordDir("../escape")).toBeNull();
    expect(() => buildStopSshRunSessionsScript("a b")).toThrow();
  });

  it("parses the stop status line", () => {
    expect(parseSshRunSessionStopStatus("motd\npaperclip-run-sessions: stopped\n")).toBe("stopped");
    expect(parseSshRunSessionStopStatus("paperclip-run-sessions: untracked\n")).toBe("untracked");
    expect(parseSshRunSessionStopStatus("paperclip-run-sessions: no-record")).toBe("no-record");
    expect(parseSshRunSessionStopStatus("paperclip-run-sessions: stoppedx\n")).toBeNull();
    expect(parseSshRunSessionStopStatus("")).toBeNull();
  });

  it("prunes record dirs untouched for 30 days and keeps fresh ones", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-prune-"));
    try {
      const root = path.join(home, ".paperclip/run-sessions");
      await mkdir(path.join(root, "stale"), { recursive: true });
      await mkdir(path.join(root, "fresh"), { recursive: true });
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      await utimes(path.join(root, "stale"), old, old);
      const result = await runSh(buildPruneSshRunSessionRecordsScript(), { PATH: process.env.PATH, HOME: home });
      expect(result.code).toBe(0);
      expect(existsSync(path.join(root, "stale"))).toBe(false);
      expect(existsSync(path.join(root, "fresh"))).toBe(true);
      // No record root at all is not an error.
      expect((await runSh(buildPruneSshRunSessionRecordsScript(), { PATH: process.env.PATH, HOME: path.join(home, "none") })).code).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

const describeLinux = existsSync("/proc/self/stat") ? describe : describe.skip;

describeLinux("SSH run session stop (real processes)", () => {
  let home: string;
  const children: ChildProcess[] = [];
  const pids: number[] = [];

  afterEach(async () => {
    for (const pid of pids.splice(0)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    for (const child of children.splice(0)) child.kill("SIGKILL");
    if (home) {
      await chmod(path.join(home, ".paperclip/run-sessions", RUN_ID, "unreadable"), 0o600).catch(() => {});
      await rm(home, { recursive: true, force: true });
    }
  });

  async function makeHome() {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-session-"));
    return home;
  }

  // Runs the remote script exactly as the spawn target sends it, in a new
  // session, as sshd does for a non-pty exec channel.
  async function spawnAsSshd(command: string, args: string[]) {
    const target = await buildSshSpawnTarget({
      spec: { ...spec, remoteCwd: home },
      command,
      args,
      env: { PAPERCLIP_RUN_ID: RUN_ID },
    });
    await target.cleanup();
    const child = spawn("sh", ["-c", String(target.args.at(-1))], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH, HOME: home },
    });
    children.push(child);
    return child;
  }

  it("stops the recorded session's members and the run's setsid escapes, and nothing else", async () => {
    await makeHome();
    const pidFile = path.join(home, "pids");
    const escapeFile = path.join(home, "escape");
    const clearedFile = path.join(home, "cleared");
    const stubbornFile = path.join(home, "stubborn");
    // An orphan whose parent exits at once (re-parented away from the run),
    // a child, a process that leaves the session with setsid but keeps the
    // run's environment, one that leaves with setsid and clears its
    // environment (the documented limitation), a setsid escape that ignores
    // TERM (so the run-id set must reach the KILL pass), and a shell that
    // ignores TERM and so needs KILL.
    const child = await spawnAsSshd("sh", ["-c", [
      `(sleep 301 & echo $! >> ${pidFile})`,
      `sleep 302 & echo $! >> ${pidFile}`,
      `setsid sh -c 'echo $$ >> ${escapeFile}; exec sleep 303' &`,
      `setsid env -i /bin/sh -c 'echo $$ >> ${clearedFile}; exec /bin/sleep 304' &`,
      `setsid sh -c 'trap "" TERM; echo $$ >> ${stubbornFile}; exec sleep 308' &`,
      `trap '' TERM; echo $$ >> ${pidFile}; wait`,
    ].join("\n")]);
    // Same user, other sessions: one with no run id, one with another run's
    // id, and one whose run id has this run's id as a prefix.
    const outsider = spawn("sleep", ["305"], { detached: true, stdio: "ignore" });
    const otherRun = spawn("sleep", ["306"], {
      detached: true, stdio: "ignore", env: { ...process.env, PAPERCLIP_RUN_ID: OTHER_RUN_ID },
    });
    const prefixRun = spawn("sleep", ["309"], {
      detached: true, stdio: "ignore", env: { ...process.env, PAPERCLIP_RUN_ID: `${RUN_ID}0` },
    });
    children.push(outsider, otherRun, prefixRun);
    const [orphan, sleeper, shell] = await readPids(pidFile, 3);
    const [escaped] = await readPids(escapeFile, 1);
    const [cleared] = await readPids(clearedFile, 1);
    const [stubborn] = await readPids(stubbornFile, 1);
    pids.push(orphan!, sleeper!, escaped!, cleared!, stubborn!);
    const recordFile = path.join(home, ".paperclip/run-sessions", RUN_ID, String(child.pid));
    await until(() => existsSync(recordFile));
    const [sid, leaderStart] = (await readFile(recordFile, "utf8")).trim().split(" ");
    expect(Number(sid)).toBe(child.pid);
    expect(Number(leaderStart)).toBeGreaterThan(0);
    // The orphan was re-parented away from the run's processes, and still
    // shares the run's session. The setsid processes left it.
    await until(() => ![String(shell), String(child.pid)].includes(statFields(orphan!)[1]!));
    expect(statFields(orphan!)[3]).toBe(String(child.pid));
    await until(() => statFields(escaped!)[3] === String(escaped));
    await until(() => statFields(cleared!)[3] === String(cleared));

    const result = await runSh(stopScript(RUN_ID), { PATH: process.env.PATH, HOME: home });

    expect(result).toMatchObject({ code: 0 });
    expect(parseSshRunSessionStopStatus(result.stdout)).toBe("stopped");
    for (const pid of [orphan!, sleeper!, shell!, escaped!, stubborn!]) expect(isRunning(pid)).toBe(false);
    expect(isRunning(cleared!)).toBe(true);
    expect(isRunning(outsider.pid!)).toBe(true);
    expect(isRunning(otherRun.pid!)).toBe(true);
    expect(isRunning(prefixRun.pid!)).toBe(true);
    expect(existsSync(path.join(home, ".paperclip/run-sessions", RUN_ID))).toBe(false);
  }, 20_000);

  it("treats a recorded id whose pid was reused as an empty session", async () => {
    await makeHome();
    // A live session leader whose start time differs from the record: the
    // recorded session ended and its id was reused, so nothing is signalled.
    const reuser = spawn("sleep", ["307"], { detached: true, stdio: "ignore" });
    children.push(reuser);
    const dir = path.join(home, ".paperclip/run-sessions", RUN_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, String(reuser.pid)), `${reuser.pid} 1\n`);

    const result = await runSh(stopScript(RUN_ID), { PATH: process.env.PATH, HOME: home });

    expect(parseSshRunSessionStopStatus(result.stdout)).toBe("stopped");
    expect(isRunning(reuser.pid!)).toBe(true);
  });

  it("reports no-record or untracked, never a failure, when nothing can be confirmed", async () => {
    await makeHome();
    const env = { PATH: process.env.PATH, HOME: home };
    const statusOf = async (script = stopScript(RUN_ID)) => {
      const result = await runSh(script, env);
      expect(result.code).toBe(0);
      return parseSshRunSessionStopStatus(result.stdout);
    };
    expect(await statusOf()).toBe("no-record");

    const dir = path.join(home, ".paperclip/run-sessions", RUN_ID);
    await mkdir(dir, { recursive: true });
    expect(await statusOf()).toBe("no-record");

    // The stop removes the empty record dir it found.
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "untracked"), "");
    expect(await statusOf()).toBe("untracked");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "123"), "123 not-a-number\n");
    expect(await statusOf()).toBe("untracked");
    await rm(dir, { recursive: true, force: true });

    if (process.getuid?.() !== 0) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "unreadable"), "1 1\n");
      await chmod(path.join(dir, "unreadable"), 0o000);
      expect(await statusOf()).toBe("untracked");
      await chmod(path.join(dir, "unreadable"), 0o600).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }

    // A host without /proc: a record cannot be checked.
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "999998"), "999998 4000\n");
    expect(await statusOf(stopScript(RUN_ID, path.join(home, "no-proc")))).toBe("untracked");
  });

  it("reports untracked when /proc is mounted with hidepid, including hidepid=ptraceable", async () => {
    for (const mode of ["2", "invisible", "ptraceable"]) {
      await makeHome();
      const fakeProc = await mkdtemp(path.join(home, "proc-"));
      await symlink("/proc/self", path.join(fakeProc, "self"));
      await writeFile(path.join(fakeProc, "mounts"), `proc ${fakeProc} proc rw,nosuid,hidepid=${mode} 0 0\n`);
      const dir = path.join(home, ".paperclip/run-sessions", RUN_ID);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "999998"), "999998 4000\n");

      const result = await runSh(stopScript(RUN_ID, fakeProc), { PATH: process.env.PATH, HOME: home });

      expect(result.code).toBe(0);
      expect(parseSshRunSessionStopStatus(result.stdout)).toBe("untracked");
      await rm(home, { recursive: true, force: true });
    }
  });

  it("never reports stopped while a member it cannot signal survives, even with an unreadable environment", async () => {
    await makeHome();
    // A fake /proc with one session member that no real process backs (so
    // kill fails, as for a process under another uid), whose environment is
    // unreadable. Membership comes from stat alone.
    const fakeProc = await mkdtemp(path.join(home, "proc-"));
    await symlink("/proc/self", path.join(fakeProc, "self"));
    await writeFile(path.join(fakeProc, "mounts"), "");
    const member = path.join(fakeProc, "999999");
    await mkdir(member);
    await writeFile(path.join(member, "stat"),
      "999999 (sudo helper) S 1 999998 999998 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 4242 0 0\n");
    await writeFile(path.join(member, "environ"), "");
    await chmod(path.join(member, "environ"), 0o000);
    const dir = path.join(home, ".paperclip/run-sessions", RUN_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "999998"), "999998 4000\n");

    const result = await runInFakeProc(stopScript(RUN_ID, fakeProc), fakeProc, { PATH: process.env.PATH, HOME: home });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("999999");
    expect(parseSshRunSessionStopStatus(result.stdout)).toBeNull();
    expect(existsSync(dir)).toBe(true);
  }, 20_000);

  // A recorded session with a live member, for the fail-closed cases below.
  async function recordLiveSession() {
    const member = spawn("sleep", ["310"], { detached: true, stdio: "ignore" });
    children.push(member);
    await until(() => isRunning(member.pid!));
    const dir = path.join(home, ".paperclip/run-sessions", RUN_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, String(member.pid)), `${member.pid} ${startTimeOf(member.pid!)}\n`);
    return member;
  }

  it("reports untracked, not stopped, when awk is missing", async () => {
    await makeHome();
    const member = await recordLiveSession();
    // A PATH with every tool the stop uses except awk.
    const bin = path.join(home, "bin");
    await mkdir(bin);
    for (const tool of ["sh", "tr", "grep", "sleep", "rm"]) {
      const resolved = await new Promise<string>((resolve) =>
        execFile("sh", ["-c", `command -v ${tool}`], (_error, stdout) => resolve(stdout.trim())));
      await symlink(resolved, path.join(bin, tool));
    }

    const result = await runSh(stopScript(RUN_ID), { PATH: bin, HOME: home });

    expect(result.code).toBe(0);
    expect(parseSshRunSessionStopStatus(result.stdout)).toBe("untracked");
    expect(isRunning(member.pid!)).toBe(true);
  });

  it("reports untracked, not stopped, when the scan cannot see pid 1 (hidepid or a security policy)", async () => {
    await makeHome();
    // The live member is hidden from the scan, as another user's process is
    // under hidepid=2 with a mount line the regex doesn't match, or under an
    // SELinux/AppArmor policy. Only the scan's own entry is visible.
    const member = await recordLiveSession();
    const fakeProc = await mkdtemp(path.join(home, "proc-"));
    await symlink("/proc/self", path.join(fakeProc, "self"));
    await writeFile(path.join(fakeProc, "mounts"), "");

    const result = await runInFakeProc(stopScript(RUN_ID, fakeProc), fakeProc, { PATH: process.env.PATH, HOME: home }, false);

    expect(result.code).toBe(0);
    expect(parseSshRunSessionStopStatus(result.stdout)).toBe("untracked");
    expect(isRunning(member.pid!)).toBe(true);
  });

  it("reports untracked, not stopped, when the scan cannot read its own /proc entry", async () => {
    await makeHome();
    const member = await recordLiveSession();
    const fakeProc = await mkdtemp(path.join(home, "proc-"));
    await symlink("/proc/self", path.join(fakeProc, "self"));
    await writeFile(path.join(fakeProc, "mounts"), "");
    await symlink("/proc/1", path.join(fakeProc, "1"));

    // Run without linking the shell's own entry in.
    const result = await runSh(stopScript(RUN_ID, fakeProc), { PATH: process.env.PATH, HOME: home });

    expect(result.code).toBe(0);
    expect(parseSshRunSessionStopStatus(result.stdout)).toBe("untracked");
    expect(isRunning(member.pid!)).toBe(true);
  });

  it("reports untracked, not stopped, when /proc cannot be enumerated", async () => {
    await makeHome();
    const member = await recordLiveSession();
    const fakeProc = await mkdtemp(path.join(home, "proc-"));
    await symlink("/proc/self", path.join(fakeProc, "self"));
    await writeFile(path.join(fakeProc, "mounts"), "");
    // Entries resolve by name, but the directory can't be listed, so the
    // scan's glob finds nothing: an empty snapshot must not read as "stopped".
    const script = stopScript(RUN_ID, fakeProc);
    await symlink("/proc/1", path.join(fakeProc, "1"));
    await chmod(fakeProc, 0o311);
    try {
      const result = await runSh(`ln -s /proc/$$ ${fakeProc}/$$ && exec sh -c ${shellQuote(script)}`,
        { PATH: process.env.PATH, HOME: home });
      expect(result.code).toBe(0);
      expect(parseSshRunSessionStopStatus(result.stdout)).toBe("untracked");
      expect(isRunning(member.pid!)).toBe(true);
    } finally {
      await chmod(fakeProc, 0o755);
    }
  });

  describe("pruning old record dirs", () => {
    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const recordRoot = () => path.join(home, ".paperclip/run-sessions");

    // A record dir holding the given files, aged `old` or left fresh.
    async function recordDir(name: string, files: Record<string, string>, old = true) {
      const dir = path.join(recordRoot(), name);
      await mkdir(dir, { recursive: true });
      for (const [file, content] of Object.entries(files)) await writeFile(path.join(dir, file), content);
      if (old) await utimes(dir, oldTime, oldTime);
      return dir;
    }

    // A session that has ended: its leader was started, killed and reaped.
    async function deadSession() {
      const leader = spawn("sleep", ["320"], { detached: true, stdio: "ignore" });
      await until(() => isRunning(leader.pid!));
      const record = `${leader.pid} ${startTimeOf(leader.pid!)}\n`;
      const exited = new Promise((resolve) => leader.on("exit", resolve));
      leader.kill("SIGKILL");
      await exited;
      return { sid: leader.pid!, record };
    }

    async function pathWithout(tool: string) {
      const bin = path.join(home, `bin-without-${tool}`);
      await mkdir(bin);
      for (const name of ["sh", "awk", "tr", "grep", "sleep", "rm", "find"].filter((name) => name !== tool)) {
        const resolved = await new Promise<string>((resolve) =>
          execFile("sh", ["-c", `command -v ${name}`], (_error, stdout) => resolve(stdout.trim())));
        await symlink(resolved, path.join(bin, name));
      }
      return bin;
    }

    it("keeps an old dir while its session is alive, and prunes it once the session has ended", async () => {
      await makeHome();
      // A live session leader (spawned detached, so in its own session).
      const leader = spawn("sleep", ["321"], { detached: true, stdio: "ignore" });
      children.push(leader);
      await until(() => isRunning(leader.pid!));
      // A session whose leader has exited but whose member still runs.
      const pidFile = path.join(home, "member");
      const orphaned = spawn("sh", ["-c", `sleep 322 & echo $! > ${pidFile}`], { detached: true, stdio: "ignore" });
      const [member] = await readPids(pidFile, 1);
      pids.push(member!);
      await until(() => !isRunning(orphaned.pid!));
      expect(statFields(member!)[3]).toBe(String(orphaned.pid));
      // The leader is gone, so its start time can't be read any more; the
      // spawn would have recorded one no later than the member's.
      const orphanedStart = startTimeOf(member!);
      const dead = await deadSession();
      // A recorded sid whose pid now belongs to another process: ended.
      const reuser = spawn("sleep", ["323"], { detached: true, stdio: "ignore" });
      children.push(reuser);
      await until(() => isRunning(reuser.pid!));

      const liveDir = await recordDir("live", { [String(leader.pid)]: `${leader.pid} ${startTimeOf(leader.pid!)}\n` });
      const memberDir = await recordDir("member", { [String(orphaned.pid)]: `${orphaned.pid} ${orphanedStart}\n` });
      const deadDir = await recordDir("dead", { [String(dead.sid)]: dead.record });
      const reusedDir = await recordDir("reused", { [String(reuser.pid)]: `${reuser.pid} 1\n` });
      const youngDir = await recordDir("young", { [String(dead.sid)]: dead.record }, false);

      const result = await runSh(buildPruneSshRunSessionRecordsScript(), { PATH: process.env.PATH, HOME: home });

      expect(result.code).toBe(0);
      expect(existsSync(liveDir)).toBe(true);
      expect(existsSync(memberDir)).toBe(true);
      expect(existsSync(deadDir)).toBe(false);
      expect(existsSync(reusedDir)).toBe(false);
      expect(existsSync(youngDir)).toBe(true);
      // The prune signals nothing.
      expect(isRunning(leader.pid!)).toBe(true);
      expect(isRunning(member!)).toBe(true);
    });

    it("judges two records of the same sid separately, whichever is read last", async () => {
      // After pid reuse, an old run's record and a live run's record can name
      // the same sid with different leader start times. Only the live pair's
      // dir survives. The two dirs swap contents between rounds, so each
      // record is read last in one of them.
      await makeHome();
      const leader = spawn("sleep", ["324"], { detached: true, stdio: "ignore" });
      children.push(leader);
      await until(() => isRunning(leader.pid!));
      const liveStart = Number(startTimeOf(leader.pid!));
      const sidFile = String(leader.pid);
      const live = `${leader.pid} ${liveStart}\n`;
      const ended = `${leader.pid} ${liveStart - 1000}\n`;
      for (const [first, second] of [[live, ended], [ended, live]] as const) {
        await rm(recordRoot(), { recursive: true, force: true });
        const dirA = await recordDir("run-a", { [sidFile]: first });
        const dirB = await recordDir("run-b", { [sidFile]: second });

        const result = await runSh(buildPruneSshRunSessionRecordsScript(), { PATH: process.env.PATH, HOME: home });

        expect(result.code).toBe(0);
        expect(existsSync(dirA)).toBe(first === live);
        expect(existsSync(dirB)).toBe(second === live);
      }
      expect(isRunning(leader.pid!)).toBe(true);
    });

    it("prunes an old dir whose session ended when no recorded session is alive", async () => {
      await makeHome();
      const dead = await deadSession();
      const deadDir = await recordDir("dead", { [String(dead.sid)]: dead.record });

      const result = await runSh(buildPruneSshRunSessionRecordsScript(), { PATH: process.env.PATH, HOME: home });

      expect(result.code).toBe(0);
      expect(existsSync(deadDir)).toBe(false);
    });

    it("keeps an old dir with an unreadable or malformed record", async () => {
      await makeHome();
      const malformed = await recordDir("malformed", { "123": "123 not-a-number\n" });
      const misnamed = await recordDir("misnamed", { "123": "456 789\n" });

      await runSh(buildPruneSshRunSessionRecordsScript(), { PATH: process.env.PATH, HOME: home });

      expect(existsSync(malformed)).toBe(true);
      expect(existsSync(misnamed)).toBe(true);
    });

    it("prunes nothing with a session record when awk is missing, but still prunes untracked-only dirs by age", async () => {
      await makeHome();
      const dead = await deadSession();
      const deadDir = await recordDir("dead", { [String(dead.sid)]: dead.record });
      const untrackedDir = await recordDir("untracked-only", { untracked: "" });
      const emptyDir = await recordDir("empty", {});
      const youngUntracked = await recordDir("young-untracked", { untracked: "" }, false);

      await runSh(buildPruneSshRunSessionRecordsScript(), { PATH: await pathWithout("awk"), HOME: home });

      expect(existsSync(deadDir)).toBe(true);
      expect(existsSync(untrackedDir)).toBe(false);
      expect(existsSync(emptyDir)).toBe(false);
      expect(existsSync(youngUntracked)).toBe(true);
    });

    it("prunes nothing with a session record when the scan cannot see pid 1", async () => {
      await makeHome();
      const dead = await deadSession();
      const deadDir = await recordDir("dead", { [String(dead.sid)]: dead.record });
      const fakeProc = await mkdtemp(path.join(home, "proc-"));
      await symlink("/proc/self", path.join(fakeProc, "self"));
      await writeFile(path.join(fakeProc, "mounts"), "");

      const script = buildPruneSshRunSessionRecordsScript().replaceAll("/proc", fakeProc);
      await runInFakeProc(script, fakeProc, { PATH: process.env.PATH, HOME: home }, false);

      expect(existsSync(deadDir)).toBe(true);
    });

    it("prunes nothing with a session record when /proc is mounted with hidepid", async () => {
      await makeHome();
      const dead = await deadSession();
      const deadDir = await recordDir("dead", { [String(dead.sid)]: dead.record });
      const fakeProc = await mkdtemp(path.join(home, "proc-"));
      await symlink("/proc/self", path.join(fakeProc, "self"));
      await writeFile(path.join(fakeProc, "mounts"), `none ${fakeProc} proc rw,hidepid=invisible 0 0\n`);

      const script = buildPruneSshRunSessionRecordsScript().replaceAll("/proc", fakeProc);
      await runInFakeProc(script, fakeProc, { PATH: process.env.PATH, HOME: home });

      expect(existsSync(deadDir)).toBe(true);
    });
  });

  it("never targets its own processes when its environment carries the run id", async () => {
    await makeHome();
    const member = await recordLiveSession();

    const result = await runSh(stopScript(RUN_ID), { PATH: process.env.PATH, HOME: home, PAPERCLIP_RUN_ID: RUN_ID });

    expect(result).toMatchObject({ code: 0 });
    expect(parseSshRunSessionStopStatus(result.stdout)).toBe("stopped");
    expect(isRunning(member.pid!)).toBe(false);
  }, 20_000);
});

// End to end through a real sshd, when the host has one: the run is spawned
// over ssh, cancelled by killing the local ssh client (all a cancel does
// today), and then stopped by the cleanup script over a second connection.
const sshSupport = await getSshEnvLabSupport();
const describeSshd = sshSupport.supported && existsSync("/proc/self/stat") ? describe : describe.skip;

describeSshd("SSH run session stop through sshd", () => {
  let rootDir: string | null = null;
  let state: SshEnvLabFixtureState | null = null;

  afterEach(async () => {
    if (state) await stopSshEnvLabFixture(state).catch(() => undefined);
    if (rootDir) await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    state = null;
    rootDir = null;
  });

  it("stops a cancelled run's remote processes, which outlive the local ssh client", async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-session-e2e-"));
    state = await startSshEnvLabFixture({ statePath: path.join(rootDir, "state.json") });
    const config = await buildSshEnvLabFixtureConfig(state);
    // sshd uses the account's home directory, which may differ from $HOME here.
    const remoteHome = (await runSshCommand(config, "printf %s \"$HOME\"")).stdout.trim();
    const recordRoot = path.join(remoteHome, ".paperclip/run-sessions");
    // A stale record dir, which the lease acquire prunes.
    const stale = path.join(recordRoot, `stale-${process.pid}`);
    await mkdir(stale, { recursive: true });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    const { remoteCwd } = await ensureSshWorkspaceReady(config);
    expect(existsSync(stale)).toBe(false);

    const runId = `e2e-${process.pid}-${Date.now()}`;
    const pidFile = path.join(rootDir, "remote-pids");
    const target = await buildSshSpawnTarget({
      spec: { ...config, remoteCwd },
      command: "sh",
      args: ["-c", `sleep 311 & echo $! >> ${pidFile}; setsid sh -c 'echo $$ >> ${pidFile}; exec sleep 312' & sleep 0.2; echo $$ >> ${pidFile}; wait`],
      env: { PAPERCLIP_RUN_ID: runId },
      runId,
    });
    const client = spawn("ssh", target.args, { stdio: "ignore" });
    try {
      const [sleeper, escaped, shell] = await readPids(pidFile, 3);
      await until(() => existsSync(path.join(recordRoot, runId)));
      client.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Killing the local client is all a cancel does today; the remote run
      // keeps going.
      for (const pid of [sleeper!, escaped!, shell!]) expect(isRunning(pid)).toBe(true);

      const result = await runSshCommand(config, buildStopSshRunSessionsScript(runId).replace(/^wait=10$/m, "wait=1"), {
        timeoutMs: 30_000,
      });

      expect(parseSshRunSessionStopStatus(result.stdout)).toBe("stopped");
      for (const pid of [sleeper!, escaped!, shell!]) expect(isRunning(pid)).toBe(false);
      expect(existsSync(path.join(recordRoot, runId))).toBe(false);
    } finally {
      client.kill("SIGKILL");
      for (const pid of await readFile(pidFile, "utf8").then((text) => text.trim().split(/\s+/).map(Number)).catch(() => [])) {
        try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      }
      await target.cleanup();
      await rm(path.join(recordRoot, runId), { recursive: true, force: true });
    }
  }, 60_000);
});
