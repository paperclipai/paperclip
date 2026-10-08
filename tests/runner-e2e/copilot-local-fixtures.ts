import { canonicalRemoteCopilotCommand, copilotDeathArguments, copilotDeathCommandDigest, selectOwnedCopilotProcess } from "./copilot-provider-death.js";
import { parseRemoteProcStat } from "./remote-native-fixtures.js";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { watch, lstatSync, readFileSync, readlinkSync, statSync, type FSWatcher } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { basename, join, relative } from "node:path";

export const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/** Allocate before dispatch; ordinary workspace startup cannot mutate this parent. */
export async function createDeniedTargetFixture(workspacePath: string, name: string) {
  if (!name || basename(name) !== name || name === "." || name === "..") throw new Error("Invalid denied target name");
  const directory = await mkdtemp(join(workspacePath, "pc-denied-"));
  const targetPath = join(directory, name);
  return { directory, targetPath, targetRelativePath: relative(workspacePath, targetPath), watcher: watchDeniedTarget(directory, name) };
}

/** Substitute the one authored target, never append a contradictory second path. */
export function bindDeniedTargetPrompt(prompt: string, original: string, target: string): string {
  const parts = prompt.split(original);
  if (parts.length !== 2) throw new Error("Denied prompt must name its exact target once");
  return parts.join(target);
}

export function watchDeniedTarget(directory: string, name: string) {
  if (!name || basename(name) !== name || name === "." || name === "..") throw new Error("Invalid denied target name");
  const startedAtMs = Date.now(); let targetMutationCount = 0;
  const reasons = new Set<string>();
  const before = lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Denied target parent must be a real directory");
  const targetAbsent = () => { try { lstatSync(join(directory, name)); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; } };
  if (!targetAbsent()) throw new Error("Denied target must initially be absent");
  const identity = (stat: import("node:fs").BigIntStats) => ({ dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
  const events: Array<{ sequence: number; observedAtMs: number; kind: string; target: boolean; filenameKnown: boolean }> = [];
  let eventCount = 0, lastEventAtMs = startedAtMs, closing = false;
  let final: { startedAtMs: number; endedAtMs: number; complete: boolean; targetMutationCount: number; reasons: string[]; initialParent: ReturnType<typeof identity>; finalParent: ReturnType<typeof identity> | null; events: typeof events } | undefined;
  const watcher: FSWatcher = watch(directory, (kind, filename) => {
    const observedAtMs = Date.now();
    if (observedAtMs < lastEventAtMs) reasons.add("event-order-invalid");
    lastEventAtMs = observedAtMs;
    const target = filename !== null && String(filename) === name;
    if (filename === null) reasons.add("event-filename-missing");
    if (target) targetMutationCount++;
    if (++eventCount <= 128) events.push({ sequence: eventCount, observedAtMs, kind, target, filenameKnown: filename !== null });
    else reasons.add("event-journal-overflow");
  });
  watcher.on("error", () => { reasons.add("watch-error"); });
  watcher.on("close", () => { if (!closing) reasons.add("watch-closed-before-finish"); });
  // Pin both identity and directory version across watcher installation.
  try {
    const armed = lstatSync(directory, { bigint: true });
    if (!armed.isDirectory() || armed.dev !== before.dev || armed.ino !== before.ino) reasons.add("parent-identity-changed-during-arm");
    if (armed.mtimeNs !== before.mtimeNs || armed.ctimeNs !== before.ctimeNs || !targetAbsent()) reasons.add("coverage-gap-during-arm");
  } catch { reasons.add("parent-unavailable-during-arm"); }
  return { finish() {
    if (final) return final;
    let after: import("node:fs").BigIntStats | undefined;
    try { after = lstatSync(directory, { bigint: true }); } catch { reasons.add("parent-unavailable-at-finish"); }
    // FSEvents may coalesce a rapid create/delete. A changed directory version
    // with no attributed event is a coverage gap, never proof of no mutation.
    if (after && (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory())) reasons.add("parent-identity-changed");
    if (after && (after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) && targetMutationCount === 0) reasons.add("coverage-gap-parent-version-changed");
    try { if (!targetAbsent() && targetMutationCount === 0) reasons.add("coverage-gap-unobserved-target"); } catch { reasons.add("target-unavailable-at-finish"); }
    const endedAtMs = Date.now();
    if (endedAtMs < lastEventAtMs) reasons.add("event-order-invalid");
    final = { startedAtMs, endedAtMs, complete: reasons.size === 0, targetMutationCount, reasons: [...reasons], initialParent: identity(before), finalParent: after ? identity(after) : null, events };
    closing = true; watcher.close(); return final;
  } };
}
interface ProcessIdentity { pid: number; parent: number; start: string; bootId?: string; startTicks?: string; state?: string }
export function sameObservedProcess(left: ProcessIdentity | undefined, right: ProcessIdentity): boolean {
  if (!left || left.pid !== right.pid) return false;
  if (left.bootId !== undefined || right.bootId !== undefined) return Boolean(left.bootId && left.bootId === right.bootId && left.startTicks && left.startTicks === right.startTicks);
  return left.start === right.start;
}
function processTable(): ProcessIdentity[] {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  const bootId = process.platform === "linux" ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : undefined;
  return output.split("\n").flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!m) return [];
    const pid = Number(m[1]);
    if (pid < 2) return [];
    try {
      // Match hot-restart.readProcessStartedAt, the server's Linux identity
      // source. ps lstart is rounded and does not identify the same timestamp.
      const start = process.platform === "linux" ? new Date(lstatSync(`/proc/${pid}`).ctimeMs).toISOString() : m[3]!;
      if (bootId) {
        const identity = parseRemoteProcStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"), bootId);
        if (identity.state === "Z") return [];
        return [{ pid, parent: identity.ppid, start, bootId, startTicks: identity.startTicks, state: identity.state }];
      }
      return [{ pid, parent: Number(m[2]), start }];
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
      throw error;
    }
  });
}
export interface RunProcessAuthority { pid: number; groupId: number; startedAt: string; runId: string }
export function isPerTurnRunProcess(authority: RunProcessAuthority, observed: ProcessIdentity, command: string): boolean {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(authority.runId) || authority.pid !== observed.pid || authority.groupId !== observed.pid) return false;
  const started = Date.parse(authority.startedAt), actual = Date.parse(observed.start);
  if (!Number.isFinite(started) || !Number.isFinite(actual) || started !== actual) return false;
  const args = command.trim().split(/\s+/u);
  return [["--run-id", authority.runId], ["--lifecycle-mode", "per_turn"]].every(([flag, value]) => {
    const at = args.indexOf(flag!); return at >= 0 && args.lastIndexOf(flag!) === at && args[at + 1] === value;
  });
}
/** Inspect the actual executable and its held descriptor before accepting the
 * Linux native launcher alias. Never canonicalize an unverified command name. */
function ownedProcessCommand(pid: number): readonly string[] {
  const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024 }).trim().split(/\s+/u);
  if (process.platform !== "linux" || !/^\/proc\/self\/fd\/(?:3|7)$/u.test(command[0] ?? "")) return command;
  const executable = `/proc/${pid}/exe`, descriptor = `/proc/${pid}/fd/${command[0]!.split("/").at(-1)}`;
  const executableStat = statSync(executable, { bigint: true }), descriptorStat = statSync(descriptor, { bigint: true });
  return canonicalRemoteCopilotCommand(command, readlinkSync(executable),
    { dev: String(executableStat.dev), ino: String(executableStat.ino) },
    { path: readlinkSync(descriptor), dev: String(descriptorStat.dev), ino: String(descriptorStat.ino) });
}
/** Read-only PID/start journal; never signal an API-reported or reused PID.
 * Native onSpawn publishes the runnerd child. Bind its current argv to this run
 * and per_turn lifecycle before treating its retirement as run cleanup.
 */
/** Losing a captured process identity cannot be repaired by a later empty sample. */
export function retainRunProcessIdentity<T extends { captured: boolean; live: number[]; identityChanged?: boolean }>(previous: T, current: T): T & { identityChanged: boolean } {
  return { ...current, identityChanged: previous.identityChanged === true || current.identityChanged === true };
}

export function observeRunProcesses() {
  const owned = new Map<number, ProcessIdentity>(); let root: ProcessIdentity | undefined; let providerDeathDispatched = false;
  let authorityCheck: { authority: RunProcessAuthority; observed: ProcessIdentity; commandSha256: string; accepted: boolean } | undefined;
  return {
    killOwnedCopilot() {
      if (!root || providerDeathDispatched) throw new Error("Copilot death requires a captured run and one dispatch");
      const table = processTable();
      const live = table.filter(p => sameObservedProcess(owned.get(p.pid), p)).map(p => p.pid);
      const argv = new Map(live.map(pid => [pid, ownedProcessCommand(pid)]));
      const child = selectOwnedCopilotProcess(root.pid, [...owned.values()], live, argv, copilotDeathArguments);
      const fresh = processTable();
      if (!fresh.some(p => sameObservedProcess(root, p)) || !fresh.some(p => sameObservedProcess(child, p))) throw new Error("Copilot process identity changed before death dispatch");
      const command = ownedProcessCommand(child.pid);
      if (JSON.stringify(command) !== JSON.stringify(argv.get(child.pid))) throw new Error("Copilot command changed before death dispatch");
      providerDeathDispatched = true;
      const dispatchedMonotonicNs = process.hrtime.bigint().toString();
      process.kill(child.pid, "SIGKILL");
      return { schema: "paperclip.e2e.copilot-owned-provider-death.v1", root, child, signal: "SIGKILL", commandSha256: copilotDeathCommandDigest(command), dispatchedMonotonicNs };
    },
    sample(authority?: RunProcessAuthority) {
      const table = processTable();
      if (!root && authority && authority.pid > 1 && authority.pid !== process.pid) {
        const candidate = table.find(p => p.pid === authority.pid);
        if (candidate) {
          let command: string;
          try { command = execFileSync("/bin/ps", ["-p", String(candidate.pid), "-o", "command="], { encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024 }); }
          catch { command = ""; } // A vanished/uninspectable PID supplies no authority.
          const accepted = isPerTurnRunProcess(authority, candidate, command) && processTable().some(p => sameObservedProcess(candidate, p));
          authorityCheck = { authority, observed: candidate, commandSha256: sha256(command), accepted };
          if (accepted) { root = candidate; owned.set(root.pid, root); }
        }
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const p of table) if (!owned.has(p.pid)) {
          const parent = owned.get(p.parent);
          if (parent && table.some(t => sameObservedProcess(parent, t))) { owned.set(p.pid, p); changed = true; }
        }
      }
      return { captured: Boolean(root), authorityCheck, rootObserved: root ? table.find(p => p.pid === root!.pid) : undefined,
        identityChanged: table.some(p => owned.has(p.pid) && !sameObservedProcess(owned.get(p.pid), p)),
        journal: [...owned.values()], live: table.filter(p => sameObservedProcess(owned.get(p.pid), p)).map(p => p.pid) };
    },
  };
}

/** A one-shot local fixture, not a command service: input selects no executable,
 * arguments or file path. The test owns/reaps the fixed finite child, records its
 * OS exit status, and holds the exact provider-launched client until that exit.
 */
export async function createAttachedCommandFixture(markerPath: string, delayMs = 4000, waitForFinishAttempt = false) {
  if (!Number.isInteger(delayMs) || delayMs < 100 || delayMs > 8000) throw new Error("Invalid bounded fixture delay");
  const root = await mkdtemp("/tmp/pc-copilot-"); await mkdir(join(root, "private"), { mode: 0o700 });
  const socketPath = join(root, "private", "socket"), scriptPath = join(root, "client.cjs");
  const nonce = randomBytes(16).toString("hex"), marker = `${randomBytes(24).toString("hex")}\n`;
  const script = `const net=require('node:net');const s=net.connect(process.argv[2]);let b='';s.setTimeout(${waitForFinishAttempt ? 45000 : 15000},()=>process.exit(3));s.on('error',()=>process.exit(4));s.on('connect',()=>s.write(JSON.stringify({nonce:process.argv[3],pid:process.pid})+'\\n'));s.on('data',x=>{b+=x;if(b.includes('\\n')){const r=JSON.parse(b);s.end();process.exit(r.code===0?0:5);}});`;
  await writeFile(scriptPath, script, { mode: 0o400 });
  const command = `${quote(process.execPath)} ${quote(scriptPath)} ${quote(socketPath)} ${quote(nonce)}`;
  const commandSha256 = sha256(command);
  let markerWrittenAtMs: number | null = null;
  let clientExitedAtMs: number | null = null;
  let clientObservation: ReturnType<typeof setInterval> | undefined;
  let connections = 0, child: ChildProcess | undefined, client: ProcessIdentity | undefined, failure: string | null = null;
  let exit: { observedAtMs: number; code: number; ownedProcessIdentityVerified: boolean; commandSha256: string } | null = null;
  const sockets = new Set<Socket>();
  let closed = false;
  let releasedAtMs: number | null = null;
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => { failure = "fixture_socket_error"; });
    let buffer = "";
    socket.on("data", data => {
      buffer += data; if (buffer.length > 1024) { failure = "fixture_request_too_large"; socket.destroy(); return; }
      if (!buffer.includes("\n")) return;
      connections++;
      try {
        const request = JSON.parse(buffer); buffer = "";
        if (connections !== 1 || request.nonce !== nonce || !Number.isSafeInteger(request.pid) || request.pid <= 1) throw new Error("fixture_request_invalid");
        const observed = processTable().find(p => p.pid === request.pid);
        const argv = execFileSync("/bin/ps", ["-p", String(request.pid), "-o", "command="], { encoding: "utf8", timeout: 3000 });
        if (!observed || !argv.includes(scriptPath) || !argv.includes(socketPath) || !argv.includes(nonce)) throw new Error("fixture_client_identity_invalid");
        client = observed;
        clientObservation = setInterval(() => {
          try {
            if (!processTable().some(p => sameObservedProcess(client, p))) {
              clientExitedAtMs = Date.now(); clearInterval(clientObservation);
            }
          } catch { failure = "fixture_client_observation_failed"; clearInterval(clientObservation); }
        }, 25);
        const childScript = waitForFinishAttempt
          ? `const deadline=setTimeout(()=>process.exit(3),30000);process.stdin.once('data',b=>{if(b.toString()!=='release\\n')process.exit(2);clearTimeout(deadline);setTimeout(()=>process.exit(0),${delayMs})});`
          : `setTimeout(()=>process.exit(0),${delayMs})`;
        child = spawn(process.execPath, ["-e", childScript], { env: { PATH: "/usr/bin:/bin" }, stdio: waitForFinishAttempt ? ["pipe", "ignore", "ignore"] : "ignore" });
        child.once("error", () => { failure = "fixture_child_start_failed"; socket.destroy(); });
        child.once("exit", (code, signal) => {
          exit = { observedAtMs: Date.now(), code: code ?? -1, ownedProcessIdentityVerified: Number.isInteger(child?.pid), commandSha256 };
          void (async () => {
            if (code !== 0 || signal) { failure = "fixture_child_failed"; socket.destroy(); return; }
            if (await readFile(scriptPath, "utf8") !== script) { failure = "fixture_script_changed"; socket.destroy(); return; }
            await writeFile(markerPath, marker, { flag: "wx" }); markerWrittenAtMs = Date.now(); socket.end(`${JSON.stringify({ code })}\n`);
          })().catch(() => { failure = "fixture_completion_failed"; socket.destroy(); });
        });
      } catch { failure = "fixture_request_rejected"; socket.destroy(); }
    });
  });
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); }); }
  catch (error) { server.close(); await rm(root, { recursive: true, force: true }); throw error; }
  return {
    command, commandSha256, marker,
    releaseAfterFinish() {
      if (!waitForFinishAttempt || closed || releasedAtMs !== null || !child?.stdin || child.exitCode !== null || child.signalCode !== null) throw new Error("Attached fixture release requires one live owned child");
      releasedAtMs = Date.now(); child.stdin.end("release\n"); return { releasedAtMs };
    },
    snapshot() { const table = processTable(); return { connections, failure, markerWrittenAtMs, clientExitedAtMs, commandExit: exit, childPid: child?.pid ?? null, clientPid: client?.pid ?? null, clientGone: Boolean(client) && !table.some(p => sameObservedProcess(client, p)), childGone: Boolean(exit), observedAtMs: Date.now() }; },
    async close() {
      if (closed) return; closed = true; clearInterval(clientObservation);
      let cleanupError: unknown;
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve, reject) => {
            const hard = setTimeout(() => { child!.kill("SIGKILL"); }, 3000);
            const deadline = setTimeout(() => reject(new Error("Fixture child did not settle within cleanup bound")), 5000);
            child!.once("exit", () => { clearTimeout(hard); clearTimeout(deadline); resolve(); }); child!.kill("SIGTERM");
          });
        }
      } catch (error) { cleanupError = error; }
      finally {
        for (const socket of sockets) socket.destroy();
        try { await new Promise<void>(resolve => server.close(() => resolve())); }
        finally { await rm(root, { recursive: true, force: true }); }
      }
      if (cleanupError) throw cleanupError;

    },
  };
}
