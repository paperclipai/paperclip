import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { watch, lstatSync, type FSWatcher } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";

export const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export function watchDeniedTarget(directory: string, name: string) {
  const startedAtMs = Date.now(); let complete = true, targetMutationCount = 0;
  const before = lstatSync(directory, { bigint: true });
  let final: { startedAtMs: number; endedAtMs: number; complete: boolean; targetMutationCount: number } | undefined;
  const watcher: FSWatcher = watch(directory, (_kind, filename) => {
    if (filename === null) complete = false;
    else if (String(filename) === name) targetMutationCount++;
  });
  watcher.on("error", () => { complete = false; });
  return { finish() {
    if (final) return final;
    let after: import("node:fs").BigIntStats | undefined;
    try { after = lstatSync(directory, { bigint: true }); } catch { complete = false; }
    // FSEvents may coalesce a rapid create/delete. A changed directory version
    // with no attributed event is a coverage gap, never proof of no mutation.
    if (!after || after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory()) complete = false;
    if (after && (after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) && targetMutationCount === 0) complete = false;
    final = { startedAtMs, endedAtMs: Date.now(), complete, targetMutationCount }; watcher.close(); return final;
  } };
}
interface ProcessIdentity { pid: number; parent: number; start: string }
function processTable(): ProcessIdentity[] {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  return output.split("\n").flatMap(line => { const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line); return m ? [{ pid: Number(m[1]), parent: Number(m[2]), start: m[3]! }] : []; });
}
export interface RunProcessAuthority { pid: number; groupId: number; startedAt: string; runId: string }
export function isPerTurnRunProcess(authority: RunProcessAuthority, observed: ProcessIdentity, command: string): boolean {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(authority.runId) || authority.pid !== observed.pid || authority.groupId !== observed.pid) return false;
  const started = Date.parse(authority.startedAt), actual = Date.parse(observed.start);
  if (!Number.isFinite(started) || !Number.isFinite(actual) || Math.floor(started / 1000) !== Math.floor(actual / 1000)) return false;
  const args = command.trim().split(/\s+/u);
  return [["--run-id", authority.runId], ["--lifecycle-mode", "per_turn"]].every(([flag, value]) => {
    const at = args.indexOf(flag!); return at >= 0 && args.lastIndexOf(flag!) === at && args[at + 1] === value;
  });
}
/** Read-only PID/start journal; never signal an API-reported or reused PID.
 * Native onSpawn publishes the runnerd child. Bind its current argv to this run
 * and per_turn lifecycle before treating its retirement as run cleanup.
 */
export function observeRunProcesses() {
  const owned = new Map<number, ProcessIdentity>(); let root: ProcessIdentity | undefined;
  return {
    sample(authority?: RunProcessAuthority) {
      const table = processTable();
      if (!root && authority && authority.pid > 1 && authority.pid !== process.pid) {
        const candidate = table.find(p => p.pid === authority.pid);
        if (candidate) {
          let command: string;
          try { command = execFileSync("/bin/ps", ["-p", String(candidate.pid), "-o", "command="], { encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024 }); }
          catch { command = ""; } // A vanished/uninspectable PID supplies no authority.
          if (isPerTurnRunProcess(authority, candidate, command) && processTable().some(p => p.pid === candidate.pid && p.start === candidate.start)) { root = candidate; owned.set(root.pid, root); }
        }
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const p of table) if (!owned.has(p.pid)) {
          const parent = owned.get(p.parent);
          if (parent && table.some(t => t.pid === parent.pid && t.start === parent.start)) { owned.set(p.pid, p); changed = true; }
        }
      }
      return { captured: Boolean(root), journal: [...owned.values()], live: table.filter(p => owned.get(p.pid)?.start === p.start).map(p => p.pid) };
    },
  };
}

/** A one-shot local fixture, not a command service: input selects no executable,
 * arguments or file path. The test owns/reaps the fixed finite child, records its
 * OS exit status, and holds the exact provider-launched client until that exit.
 */
export async function createAttachedCommandFixture(markerPath: string, delayMs = 4000) {
  if (!Number.isInteger(delayMs) || delayMs < 100 || delayMs > 8000) throw new Error("Invalid bounded fixture delay");
  const root = await mkdtemp("/tmp/pc-copilot-"); await mkdir(join(root, "private"), { mode: 0o700 });
  const socketPath = join(root, "private", "socket"), scriptPath = join(root, "client.cjs");
  const nonce = randomBytes(16).toString("hex"), marker = `${randomBytes(24).toString("hex")}\n`;
  const script = `const net=require('node:net');const s=net.connect(process.argv[2]);let b='';s.setTimeout(15000,()=>process.exit(3));s.on('error',()=>process.exit(4));s.on('connect',()=>s.write(JSON.stringify({nonce:process.argv[3],pid:process.pid})+'\\n'));s.on('data',x=>{b+=x;if(b.includes('\\n')){const r=JSON.parse(b);s.end();process.exit(r.code===0?0:5);}});`;
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
            if (!processTable().some(p => p.pid === client!.pid && p.start === client!.start)) {
              clientExitedAtMs = Date.now(); clearInterval(clientObservation);
            }
          } catch { failure = "fixture_client_observation_failed"; clearInterval(clientObservation); }
        }, 25);
        child = spawn(process.execPath, ["-e", `setTimeout(()=>process.exit(0),${delayMs})`], { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" });
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
    snapshot() { const table = processTable(); return { connections, failure, markerWrittenAtMs, clientExitedAtMs, commandExit: exit, childPid: child?.pid ?? null, clientPid: client?.pid ?? null, clientGone: Boolean(client) && !table.some(p => p.pid === client!.pid && p.start === client!.start), childGone: Boolean(exit), observedAtMs: Date.now() }; },
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
