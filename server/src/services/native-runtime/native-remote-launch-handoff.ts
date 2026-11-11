import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { DurableRecoveryIdentity, RunnerProcessLaunchSpec } from "../../vendor/paperclip-runner/index.js";

export type NativeRemoteLaunchIntent = {
  schema: "paperclip.native-remote-launch-intent.v1";
  launchId: string;
  nonce: string;
  identity: DurableRecoveryIdentity;
  checkpoint: { headerSha256: string; cursorSha256: string; partsSha256: string };
  remoteCwd: string;
  remoteBinary: string;
  processIdentityPath: string;
  stateDirectory: string;
  diagnosticsDirectory: string;
  runnerVersion: string;
  runnerDigest: string;
  launchConfigSha256: string;
};

export type NativeRemoteLaunchReceipt = {
  schema: "paperclip.native-remote-launch-receipt.v1";
  intentSha256: string;
  nonce: string;
  pid: number;
  startedAt: string;
  processStartFingerprint: string;
  processGroupId: null;
};

const launchCodes = ["native_remote_launch_intent_invalid", "native_remote_launch_identity_mismatch",
  "native_remote_launch_configuration_changed", "native_remote_launch_path_unsafe",
  "native_remote_launch_receipt_pending", "native_remote_launch_receipt_unavailable",
  "native_remote_launch_process_exited", "native_remote_launch_fingerprint_unavailable"] as const;
type LaunchCode = typeof launchCodes[number];

export class NativeRemoteLaunchHandoffError extends Error {
  readonly classification: "native_provider_state_incompatible" | null;
  constructor(readonly code: LaunchCode) {
    super(code);
    this.name = "NativeRemoteLaunchHandoffError";
    this.classification = code === "native_remote_launch_intent_invalid" || code === "native_remote_launch_identity_mismatch"
      || code === "native_remote_launch_configuration_changed" || code === "native_remote_launch_path_unsafe"
      ? "native_provider_state_incompatible" : null;
  }
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identityFields = ["runnerInstanceId", "environmentLeaseId", "runId", "normalizedSessionId", "turnId", "itemId"] as const;
const sha256 = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail: (code: LaunchCode) => never = code => { throw new NativeRemoteLaunchHandoffError(code); };

export function assertNativeRemoteLaunchIntent(intent: NativeRemoteLaunchIntent): void {
  if (intent?.schema !== "paperclip.native-remote-launch-intent.v1" || !uuid.test(intent.launchId) || !uuid.test(intent.nonce)
    || !identityFields.every(key => typeof intent.identity?.[key] === "string" && intent.identity[key].length > 0
      && intent.identity[key].length <= 1024 && !/[\0\r\n]/.test(intent.identity[key]))
    || ![intent.checkpoint?.headerSha256, intent.checkpoint?.cursorSha256, intent.checkpoint?.partsSha256,
      intent.launchConfigSha256].every(value => typeof value === "string" && sha256.test(value))
    || typeof intent.runnerVersion !== "string" || !intent.runnerVersion || !/^sha256:[a-f0-9]{64}$/.test(intent.runnerDigest)) {
    fail("native_remote_launch_intent_invalid");
  }
  for (const value of [intent.remoteCwd, intent.remoteBinary, intent.processIdentityPath, intent.stateDirectory, intent.diagnosticsDirectory]) {
    if (typeof value !== "string" || !posix.isAbsolute(value) || posix.normalize(value) !== value || value.includes("\0") || value === "/") {
      fail("native_remote_launch_path_unsafe");
    }
  }
  for (const value of [intent.processIdentityPath, intent.stateDirectory, intent.diagnosticsDirectory]) {
    const relative = posix.relative(intent.remoteCwd, value);
    if (!relative || relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) fail("native_remote_launch_path_unsafe");
  }
  if (posix.dirname(intent.processIdentityPath) !== intent.stateDirectory) fail("native_remote_launch_path_unsafe");
}

function configuration(input: Pick<NativeRemoteLaunchIntent, "remoteBinary" | "remoteCwd" | "diagnosticsDirectory">,
  spec: RunnerProcessLaunchSpec) {
  const args = [...spec.args];
  const index = args.indexOf("--diagnostics-directory");
  if (index >= 0) args[index + 1] = input.diagnosticsDirectory;
  else args.push("--diagnostics-directory", input.diagnosticsDirectory);
  const environment = Object.fromEntries(Object.entries(spec.environment).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string").sort(([left], [right]) => left.localeCompare(right)));
  return { command: input.remoteBinary, args, cwd: input.remoteCwd, environment };
}

function assertConfiguration(intent: NativeRemoteLaunchIntent, spec: RunnerProcessLaunchSpec) {
  assertNativeRemoteLaunchIntent(intent);
  if (!spec || typeof spec.command !== "string" || typeof spec.cwd !== "string"
    || !Array.isArray(spec.args) || !spec.args.every(arg => typeof arg === "string")
    || !spec.environment || typeof spec.environment !== "object" || Array.isArray(spec.environment)
    || !Object.values(spec.environment).every(value => value === undefined || typeof value === "string")) {
    fail("native_remote_launch_configuration_changed");
  }
  const config = configuration(intent, spec);
  if (digest(config) !== intent.launchConfigSha256) fail("native_remote_launch_configuration_changed");
  const expected = { "--runner-id": intent.identity.runnerInstanceId, "--environment-lease-id": intent.identity.environmentLeaseId,
    "--run-id": intent.identity.runId, "--session-id": intent.identity.normalizedSessionId,
    "--turn-id": intent.identity.turnId, "--item-id": intent.identity.itemId,
    "--runner-version": intent.runnerVersion, "--runner-digest": intent.runnerDigest, "--state-dir": intent.stateDirectory };
  for (const [flag, value] of Object.entries(expected)) {
    if (config.args.filter(arg => arg === flag).length !== 1 || config.args[config.args.indexOf(flag) + 1] !== value) {
      fail("native_remote_launch_identity_mismatch");
    }
  }
  return config;
}

export function nativeRemoteLaunchConfigurationMatches(intent: NativeRemoteLaunchIntent, spec: RunnerProcessLaunchSpec | undefined) {
  if (!spec) return false;
  try { assertConfiguration(intent, spec); return true; } catch { return false; }
}

export function createNativeRemoteLaunchIntent(input: Omit<NativeRemoteLaunchIntent, "schema" | "launchId" | "nonce" | "launchConfigSha256">
  & { spec: RunnerProcessLaunchSpec }): NativeRemoteLaunchIntent {
  const { spec, ...binding } = input;
  const intent: NativeRemoteLaunchIntent = { ...binding, schema: "paperclip.native-remote-launch-intent.v1",
    launchId: randomUUID(), nonce: randomUUID(), launchConfigSha256: digest(configuration(binding, spec)) };
  assertConfiguration(intent, spec);
  return intent;
}

export const NATIVE_REMOTE_LAUNCH_SCRIPT = String.raw`
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), cp = require("node:child_process");
const [mode, encodedIntent, encodedConfig, source] = process.argv.slice(1);
const intent = JSON.parse(Buffer.from(encodedIntent, "base64").toString("utf8"));
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = code => { throw Error(code); };
const anchor = fs.realpathSync(intent.remoteCwd);
const claimDirectory = intent.processIdentityPath + ".launch";
function confined(target, create = false) {
  const relative = path.relative(intent.remoteCwd, target);
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) fail("native_remote_launch_path_unsafe");
  let current = anchor;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat && create) { try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; } stat = fs.lstatSync(current); }
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("native_remote_launch_path_unsafe");
  }
  return true;
}
function file(target) {
  if (!confined(path.dirname(target))) return null;
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384
    || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) fail("native_remote_launch_path_unsafe");
  return fs.readFileSync(target, "utf8");
}
function put(target, value) {
  if (fs.lstatSync(target, { throwIfNoEntry: false })) fail("native_remote_launch_identity_mismatch");
  const temporary = target + ".tmp." + process.pid;
  fs.writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
  const fd = fs.openSync(temporary, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
  const directory = fs.openSync(path.dirname(target), "r"); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function fingerprint(pid) {
  const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
  const end = stat.lastIndexOf(") "), ticks = stat.slice(end + 2).trim().split(/\s+/)[19];
  const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (end < 0 || !/^\d+$/.test(ticks || "") || !/^[a-f0-9-]+$/i.test(boot)) fail("native_remote_launch_fingerprint_unavailable");
  return "linux:" + boot + ":" + ticks;
}
function intentDirectory(value = intent) {
  const text = file(path.join(claimDirectory, "intent.json"));
  if (text === null || JSON.parse(text).nonce === value.nonce) return claimDirectory;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.nonce)) fail("native_remote_launch_identity_mismatch");
  return path.join(claimDirectory, value.nonce);
}
function storedIntent(directory = intentDirectory()) {
  const text = file(path.join(directory, "intent.json"));
  if (text === null) return false;
  if (hash(JSON.parse(text)) !== hash(intent)) fail("native_remote_launch_identity_mismatch");
  return true;
}
function receiptFor(expected, directory) {
  const text = file(path.join(directory, "receipt.json"));
  if (text === null) return null;
  const receipt = JSON.parse(text);
  if (receipt.schema !== "paperclip.native-remote-launch-receipt.v1" || receipt.intentSha256 !== hash(expected)
    || receipt.nonce !== expected.nonce || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1
    || !Number.isFinite(Date.parse(receipt.startedAt)) || !/^linux:[a-f0-9-]+:[0-9]+$/i.test(receipt.processStartFingerprint)
    || receipt.processGroupId !== null) {
    fail("native_remote_launch_identity_mismatch");
  }
  return receipt;
}
function markerFor(expected, receipt) {
  return [expected.nonce, receipt.pid, receipt.startedAt, expected.identity.runnerInstanceId, receipt.processStartFingerprint, ""].join("\n");
}
function read() {
  const directory = intentDirectory();
  if (!confined(directory) || !storedIntent(directory)) return { kind: "pending" };
  const receipt = receiptFor(intent, directory);
  if (receipt === null) return { kind: "pending" };
  try { process.kill(receipt.pid, 0); } catch (error) {
    if (error.code === "ESRCH") fail("native_remote_launch_process_exited");
    throw error;
  }
  if (file(intent.processIdentityPath) !== markerFor(intent, receipt)) fail("native_remote_launch_identity_mismatch");
  if (fingerprint(receipt.pid) !== receipt.processStartFingerprint) fail("native_remote_launch_identity_mismatch");
  return { kind: "published", receipt };
}
function previousStopped() {
  const marker = file(intent.processIdentityPath);
  if (marker === null) fail("native_remote_launch_receipt_pending");
  const previousDirectory = intentDirectory({ nonce: marker.split("\n")[0] });
  const text = file(path.join(previousDirectory, "intent.json"));
  if (text === null) fail("native_remote_launch_receipt_pending");
  const previous = JSON.parse(text), receipt = receiptFor(previous, previousDirectory);
  if (previous.schema !== intent.schema || previous.launchId === intent.launchId || previous.processIdentityPath !== intent.processIdentityPath
    || previous.remoteCwd !== intent.remoteCwd || previous.stateDirectory !== intent.stateDirectory
    || previous.identity?.environmentLeaseId !== intent.identity.environmentLeaseId
    || previous.identity?.normalizedSessionId !== intent.identity.normalizedSessionId
    || receipt === null || marker !== markerFor(previous, receipt)) fail("native_remote_launch_identity_mismatch");
  let stopped = false;
  try { process.kill(receipt.pid, 0); }
  catch (error) { if (error.code === "ESRCH") stopped = true; else throw error; }
  if (!stopped && fingerprint(receipt.pid) === receipt.processStartFingerprint) fail("native_remote_launch_receipt_pending");
  if (file(intent.processIdentityPath) !== marker) fail("native_remote_launch_identity_mismatch");
}
function claim() {
  const directory = intentDirectory();
  if (confined(directory)) { storedIntent(directory); return false; }
  if (!confined(claimDirectory)) {
    if (file(intent.processIdentityPath) !== null) fail("native_remote_launch_identity_mismatch");
    try { fs.mkdirSync(path.join(anchor, path.relative(intent.remoteCwd, claimDirectory)), { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST") return false; throw error; }
    put(path.join(claimDirectory, "intent.json"), JSON.stringify(intent));
    return true;
  }
  const lock = path.join(claimDirectory, "handoff");
  try { fs.mkdirSync(path.join(anchor, path.relative(intent.remoteCwd, lock)), { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") { confined(lock); return false; } throw error; }
  try {
    if (confined(directory)) { storedIntent(directory); return false; }
    previousStopped();
    fs.mkdirSync(path.join(anchor, path.relative(intent.remoteCwd, directory)), { mode: 0o700 });
    put(path.join(directory, "intent.json"), JSON.stringify(intent));
    fs.unlinkSync(intent.processIdentityPath);
    return true;
  } finally { fs.rmdirSync(lock); }
}
try {
  if (mode === "read") { process.stdout.write(JSON.stringify(read())); }
  else if (mode === "launch") {
    if (confined(intentDirectory())) process.stdout.write(JSON.stringify(read()));
    else {
      confined(intent.stateDirectory); confined(intent.diagnosticsDirectory);
      if (confined(claimDirectory)) previousStopped();
      if (!confined(claimDirectory) && file(intent.processIdentityPath) !== null) fail("native_remote_launch_identity_mismatch");
      const worker = cp.spawn(process.execPath, ["-e", source, "worker", encodedIntent, encodedConfig, source],
        { cwd: intent.remoteCwd, env: process.env, detached: true, stdio: "ignore" });
      worker.unref();
      process.stdout.write(JSON.stringify({ kind: "pending" }));
    }
  } else if (mode === "worker") {
    const config = JSON.parse(Buffer.from(encodedConfig, "base64").toString("utf8"));
    const environment = Object.fromEntries(config.environmentKeys.map(key => [key, process.env[key]]));
    if (hash({ command: config.command, args: config.args, cwd: config.cwd, environment }) !== intent.launchConfigSha256) {
      fail("native_remote_launch_configuration_changed");
    }
    confined(intent.stateDirectory, true); confined(intent.diagnosticsDirectory, true);
    if (!claim()) process.exit(0);
    const shell = 'set -eu; node_binary=$1; script=$2; launch_intent=$3; shift 3; "$node_binary" -e "$script" publish "$launch_intent" "$$"; exec "$@"';
    const child = cp.spawn("sh", ["-c", shell, "paperclip-runner-child", process.execPath, source, encodedIntent,
      config.command, ...config.args], { cwd: config.cwd, env: process.env, detached: true, stdio: "ignore" });
    child.unref();
  } else if (mode === "publish") {
    if (!storedIntent()) fail("native_remote_launch_receipt_pending");
    const pid = Number(encodedConfig), startedAt = new Date().toISOString(), processStartFingerprint = fingerprint(pid);
    const receipt = { schema: "paperclip.native-remote-launch-receipt.v1", intentSha256: hash(intent), nonce: intent.nonce,
      pid, startedAt, processStartFingerprint, processGroupId: null };
    put(intent.processIdentityPath, [intent.nonce, pid, startedAt, intent.identity.runnerInstanceId, processStartFingerprint, ""].join("\n"));
    put(path.join(intentDirectory(), "receipt.json"), JSON.stringify(receipt));
  } else fail("native_remote_launch_intent_invalid");
} catch (error) {
  const code = /^native_remote_launch_[a-z_]+$/.test(error.message) ? error.message : "native_remote_launch_receipt_unavailable";
  process.stdout.write(JSON.stringify({ kind: "refused", code })); process.exitCode = 1;
}
`;

type ProbeInput = { runner: CommandManagedRuntimeRunner; intent: NativeRemoteLaunchIntent; deadline?: number };

function deadlineFor(deadline?: number) {
  if (deadline !== undefined && !Number.isFinite(deadline)) fail("native_remote_launch_receipt_pending");
  return Math.min(deadline ?? Date.now() + 20_000, Date.now() + 30_000);
}

async function observe(input: ProbeInput, mode: "read" | "launch", config?: ReturnType<typeof configuration>) {
  const encoded = Buffer.from(JSON.stringify(input.intent)).toString("base64");
  const remoteConfig = config ? { command: config.command, args: config.args, cwd: config.cwd,
    environmentKeys: Object.keys(config.environment) } : null;
  const result = await input.runner.execute({ command: "node", args: ["-e", NATIVE_REMOTE_LAUNCH_SCRIPT, mode, encoded,
    Buffer.from(JSON.stringify(remoteConfig)).toString("base64"), NATIVE_REMOTE_LAUNCH_SCRIPT],
    cwd: input.intent.remoteCwd, ...(config ? { env: config.environment } : {}), bypassSession: true,
    timeoutMs: Math.max(1, Math.min(10_000, (input.deadline ?? Date.now() + 20_000) - Date.now())) });
  if (result.timedOut || Buffer.byteLength(result.stdout) > 16_384) fail("native_remote_launch_receipt_unavailable");
  let body: { kind: string; code?: LaunchCode; receipt?: NativeRemoteLaunchReceipt };
  try { body = JSON.parse(result.stdout); } catch { fail("native_remote_launch_receipt_unavailable"); }
  if (body.kind === "refused") fail(launchCodes.includes(body.code as LaunchCode)
    ? body.code! : "native_remote_launch_receipt_unavailable");
  if (result.exitCode !== 0) fail("native_remote_launch_receipt_unavailable");
  if (body.kind === "pending") return null;
  const receipt = body.receipt;
  if (body.kind !== "published" || !receipt || receipt.schema !== "paperclip.native-remote-launch-receipt.v1"
    || receipt.intentSha256 !== digest(input.intent) || receipt.nonce !== input.intent.nonce
    || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1 || !Number.isFinite(Date.parse(receipt.startedAt))
    || !/^linux:[a-f0-9-]+:[0-9]+$/i.test(receipt.processStartFingerprint) || receipt.processGroupId !== null) {
    fail("native_remote_launch_identity_mismatch");
  }
  return receipt;
}

export async function readNativeRemoteLaunchReceipt(input: ProbeInput): Promise<NativeRemoteLaunchReceipt> {
  assertNativeRemoteLaunchIntent(input.intent);
  const deadline = deadlineFor(input.deadline);
  while (Date.now() < deadline) {
    try {
      const receipt = await observe({ ...input, deadline }, "read");
      if (receipt) return receipt;
    } catch (error) {
      if (error instanceof NativeRemoteLaunchHandoffError && error.code !== "native_remote_launch_receipt_unavailable") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  fail("native_remote_launch_receipt_pending");
}

export async function launchNativeRemoteRunnerOnce(input: ProbeInput & { spec: RunnerProcessLaunchSpec }): Promise<NativeRemoteLaunchReceipt> {
  const config = assertConfiguration(input.intent, input.spec);
  const deadline = deadlineFor(input.deadline);
  if (Date.now() >= deadline) fail("native_remote_launch_receipt_pending");
  try {
    const receipt = await observe({ ...input, deadline }, "launch", config);
    if (receipt) return receipt;
  } catch (error) {
    if (error instanceof NativeRemoteLaunchHandoffError && error.code !== "native_remote_launch_receipt_unavailable") throw error;
  }
  return readNativeRemoteLaunchReceipt({ ...input, deadline });
}
