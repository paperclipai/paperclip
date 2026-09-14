/**
 * Dependency-free service supervisor, also usable inside a sandbox. Bootstrap
 * arrives over stdin, not argv or a file. Only process identity and exit state
 * are journaled. stdout/stderr are redacted before they reach the durable log.
 */
export const runtimeServiceLocalHostSource = String.raw`
"use strict";
const fs = require("node:fs");
const { spawn, execFileSync } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

function identity(pid) {
  if (process.platform === "linux") {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const init = fs.readFileSync("/proc/1/stat", "utf8");
    return init.slice(init.lastIndexOf(")") + 2).split(" ")[19] + ":" + stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  }
  return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).trim();
}
let bootstrap = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  bootstrap += chunk;
  if (bootstrap.length > 1024 * 1024) process.exit(64);
});
process.stdin.on("end", () => {
  let input;
  try { input = JSON.parse(bootstrap); } catch { process.exit(64); }
  bootstrap = "";
  const receiptPath = process.argv[2];
  const logPath = process.argv[3];
  const receipt = { generation: input.generation, ports: input.ports, pid: process.pid, identity: identity(process.pid), childPid: null, childIdentity: null, state: "starting", exitCode: null };
  let child = null;
  let stopping = false;
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // The process itself claims the generation before spawning any application.
  // A controller losing its lease cannot launch a second copy of this generation.
  // link publishes complete JSON atomically while retaining create-only semantics.
  const claim = receiptPath + "." + process.pid + ".claim";
  fs.writeFileSync(claim, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
  let claimError = null;
  try { fs.linkSync(claim, receiptPath); } catch (error) { claimError = error; }
  fs.unlinkSync(claim);
  if (claimError) process.exit(claimError.code === "EEXIST" ? 0 : 73);
  function save() {
    const temp = receiptPath + "." + process.pid + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(receipt), { mode: 0o600 });
    fs.renameSync(temp, receiptPath);
  }
  const log = fs.openSync(logPath, "a", 0o600);
  let logBytes = fs.fstatSync(log).size;
  function write(text) {
    if (logBytes > 10 * 1024 * 1024) {
      fs.ftruncateSync(log, 0);
      logBytes = 0;
    }
    fs.writeSync(log, text);
    logBytes += Buffer.byteLength(text);
  }
  const secrets = [...new Set(input.secrets.filter((value) => typeof value === "string" && value.length))].sort((a,b) => b.length-a.length);
  function redactStream(stream) {
    let pending = "";
    const decoder = new StringDecoder("utf8");
    const keep = Math.max(1, ...secrets.map((secret) => secret.length)) - 1;
    function flush(final) {
      while (pending.length) {
        const safeCount = final ? pending.length : Math.max(0, pending.length - keep);
        if (!safeCount) break;
        let index = -1;
        let found = "";
        for (const secret of secrets) {
          const position = pending.indexOf(secret);
          if (position >= 0 && position < safeCount && (index < 0 || position < index)) { index = position; found = secret; }
        }
        if (index >= 0) {
          write(pending.slice(0, index) + "[REDACTED]");
          pending = pending.slice(index + found.length);
        } else {
          write(pending.slice(0, safeCount)); pending = pending.slice(safeCount);
          break;
        }
      }
    }
    stream.on("data", (chunk) => { pending += decoder.write(chunk); flush(false); });
    stream.on("end", () => { pending += decoder.end(); flush(true); });
  }
  child = spawn(input.executable || "/bin/sh", input.args || ["-c", input.command], {
    cwd: input.cwd, env: input.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  function signalChild(signal) {
    if (child && child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  }
  function stop() {
    if (stopping) return;
    stopping = true;
    receipt.state = "stopping";
    save();
    signalChild("SIGTERM");
    setTimeout(() => signalChild("SIGKILL"), 2000).unref();
  }
  child.on("spawn", () => {
    receipt.childPid = child.pid;
    try { receipt.childIdentity = identity(child.pid); } catch {}
    receipt.state = stopping ? "stopping" : "running";
    save();
    if (stopping) signalChild("SIGTERM");
  });
  child.on("error", () => {
    receipt.state = "exited";
    receipt.exitCode = 127;
    save();
    write("Unable to launch service command.\n");
  });
  redactStream(child.stdout);
  redactStream(child.stderr);
  child.on("exit", (code) => {
    receipt.state = "exited";
    receipt.exitCode = code;
    signalChild("SIGKILL");
    save();
  });
  child.on("close", () => { fs.closeSync(log); process.exit(receipt.exitCode || 0); });
});
`;
