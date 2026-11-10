// PRIVATE UNRUN fixture source. One JSON request over stdin, never secret argv.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { kernelIdentity, launchFromActualCommand, readActualRunnerProof } from "./linux-process-custody.mjs";

const fail = code => Object.assign(new Error(code), { code });
const limit = 4 * 1024 * 1024;
const chunks = []; let size = 0;
try {
  if (process.platform !== "linux" || process.versions.node !== "24.22.2") throw fail("linux_node_identity_required");
  for await (const chunk of process.stdin) { size += chunk.length; if (size > limit) throw fail("request_overflow"); chunks.push(chunk); }
  const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  // Resource descriptor is a private mount written by the host for ONE lease.
  const descriptorPath = process.argv[2];
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  if (descriptor.containerId !== request.containerId || descriptor.id !== request.providerLeaseId
      || descriptor.runId !== request.runId || descriptor.nonce !== request.nonce || descriptor.companyId !== request.companyId || descriptor.environmentId !== request.environmentId) throw fail("foreign_lease_request");
  const root = await realpath(descriptor.root);
  if (root !== descriptor.root || root === "/" || request.command?.length > 4096 || !request.command || !Array.isArray(request.args)
      || request.args.some(value => typeof value !== "string" || value.length > 131072)) throw fail("invalid_command_request");
  const cwd = await realpath(request.cwd ?? root);
  if (cwd !== root && !cwd.startsWith(root + "/")) throw fail("foreign_command_cwd");
  const deadline = request.timeoutMs;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 90000) throw fail("command_budget_invalid");
  const environment = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp") };
  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) throw fail("command_environment_invalid");
    // Normal Runner supplies its controlled PATH. Never inherit this relay's env.
    environment[key] = value;
  }
  await mkdir(environment.HOME, { recursive: true }); await mkdir(environment.TMPDIR, { recursive: true });
  const launch = launchFromActualCommand(descriptor, request);
  const ledgerDirectory = path.join(root, ".qualification-custody"); await mkdir(ledgerDirectory, { recursive: true, mode: 0o700 });
  if (!/^[a-f0-9-]{36}$/.test(request.requestId)) throw fail("request_identity_invalid");
  const journal = path.join(ledgerDirectory, request.requestId + ".json");
  // Exclusive record before dispatch: unknown response must not silently reexecute.
  await writeFile(journal, JSON.stringify({ status: "dispatch_recorded", requestId: request.requestId, launch }), { flag: "wx", mode: 0o600 });
  if (launch) {
    if (descriptor.launchDescriptor !== path.join(ledgerDirectory, "active-launch.json")) throw fail("launch_journal_path_invalid");
    await writeFile(descriptor.launchDescriptor, JSON.stringify(launch), { flag: "wx", mode: 0o600 });
  }
  const child = spawn(request.command, request.args, { cwd, env: environment, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [], stderr = []; let bytes = 0, overflow = false, timedOut = false, spawnError = false, kernel = null;
  const collect = output => chunk => { bytes += chunk.length; if (bytes > limit) { overflow = true; return; } output.push(chunk); };
  child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
  child.on("error", () => { spawnError = true; });
  const joined = new Promise(resolve => child.once("close", (exitCode, signal) => resolve({ exitCode, signal })));
  if (child.pid) { try { kernel = await kernelIdentity(child.pid); } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; } }
  child.stdin.on("error", () => {}); child.stdin.end(request.stdin ?? "");
  // Signals only this child handle; a timeout is retained UNKNOWN until all
  // detached descendants/normal Runner identities are separately reconciled.
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, deadline);
  const exit = await joined; clearTimeout(timer);
  let proof = null;
  // Normal launch detaches before the marker is ready. Observe ONLY the
  // existing host waitForRemoteRunnerProcessIdentity successful read, not a
  // new provider poll or an immediate post-launch marker assumption.
  if (!timedOut && !overflow && !spawnError && exit.exitCode === 0
      && request.command === "sh" && request.args[2] === "paperclip-runner-process-identity") {
    const active = JSON.parse(await readFile(descriptor.launchDescriptor, "utf8"));
    if (request.args[3] !== active.marker) throw fail("foreign_identity_read");
    proof = await readActualRunnerProof(descriptor, active);
  }
  if (kernel) { const { argv: _privateArgv, ...safeKernel } = kernel; kernel = safeKernel; }
  const response = { requestId: request.requestId, ...exit, pid: child.pid ?? null, group: child.pid ?? null,
    kernel, joined: true, timedOut, overflow, spawnError, launch, proof,
    stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  const hash = chunks => createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
  await writeFile(journal, JSON.stringify({ requestId: request.requestId, ...exit, pid: response.pid, group: response.group,
    joined: true, timedOut, overflow, spawnError, kernel, verifiedNativeKernel: proof?.kernel ?? null,
    stdoutBytes: Buffer.concat(stdout).length, stderrBytes: Buffer.concat(stderr).length, stdoutSHA256: hash(stdout), stderrSHA256: hash(stderr) }), { mode: 0o600 });
  process.stdout.write(JSON.stringify(response));
  if (timedOut || overflow || spawnError) process.exitCode = 1;
} catch (error) {
  // Fixed classification only. Child/remote stderr and request material are NOT
  // attached as a cause or reflected in control-plane error/log output.
  process.stdout.write(JSON.stringify({ error: typeof error?.code === "string" && /^[a-z_]+$/.test(error.code) ? error.code : "linux_relay_failed", unknownOutcome: true }));
  process.exitCode = 1;
}
