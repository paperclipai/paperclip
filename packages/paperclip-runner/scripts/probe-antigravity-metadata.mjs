#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { antigravityRuntimeCachePath } from "./antigravity-provisioner-layout.mjs";
import { antigravityDistribution, verifyAntigravityDistribution } from "./materialize-antigravity-distribution.mjs";

const MAX_WIRE_BYTES = 1024 * 1024;
const CLIENT_INFO = Object.freeze({ name: "paperclip-runner", title: "Paperclip Runner", version: "1" });
const AUTH_METHOD_IDS = ["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"];
const plainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function probeLimits(options) {
  const limits = { startupTimeoutMs: options.startupTimeoutMs ?? 25_000, maxBytes: options.maxBytes ?? MAX_WIRE_BYTES,
    eofTimeoutMs: options.eofTimeoutMs ?? 500, terminateTimeoutMs: options.terminateTimeoutMs ?? 500, killTimeoutMs: options.killTimeoutMs ?? 500 };
  for (const [name, maximum] of [["startupTimeoutMs", 30_000], ["maxBytes", MAX_WIRE_BYTES], ["eofTimeoutMs", 5_000], ["terminateTimeoutMs", 5_000], ["killTimeoutMs", 5_000]]) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > maximum) throw new Error("Invalid Antigravity metadata probe limits");
  }
  return limits;
}

/** No ambient credentials, proxy, hooks, Python, Node, or configuration variables. */
export function antigravityMetadataEnvironment(root, runtimeDirectory) {
  return {
    PATH: "/usr/bin:/bin", HOME: join(root, "home"), GEMINI_HOME: join(root, "gemini"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    TMPDIR: join(root, "tmp"), AGY_ACP_FORCE_FILE_STORAGE: "1", ANTIGRAVITY_HARNESS_PATH: join(runtimeDirectory, "localharness_external"),
    NO_COLOR: "1", LANG: "en_US.UTF-8",
  };
}

/** One closed protocol exchange. Provider-authored text never enters diagnostics. */
export function createAntigravityMetadataRpc(child, { startupTimeoutMs = 25_000, maxBytes = MAX_WIRE_BYTES } = {}) {
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 30_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_WIRE_BYTES) throw new Error("Invalid Antigravity metadata probe limits");
  const decoder = new StringDecoder("utf8");
  const utf8Validator = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", bytes = 0, stderrBytes = 0, started = false, settled = false, failure, timer;
  let resolveInitialization, rejectInitialization;
  const initialized = new Promise((resolve, reject) => { resolveInitialization = resolve; rejectInitialization = reject; });
  // Failures before initialize() still have an owned rejection handler.
  initialized.catch(() => {});
  function fail(code) {
    failure ??= new Error(code);
    clearTimeout(timer);
    if (!settled) { settled = true; rejectInitialization(failure); }
  }
  function parse(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { fail("antigravity_malformed_json"); return; }
    if (!plainObject(message) || message.jsonrpc !== "2.0" || message.id !== 1 || "method" in message || settled) { fail("antigravity_unexpected_message"); return; }
    if ("error" in message) { fail("antigravity_initialize_rejected"); return; }
    if (!plainObject(message.result)) { fail("antigravity_malformed_initialize_result"); return; }
    clearTimeout(timer);
    settled = true;
    resolveInitialization(message.result);
  }
  child.stdout.on("data", chunk => {
    bytes += chunk.length;
    if (bytes > maxBytes) { fail("antigravity_stdout_limit"); return; }
    try { utf8Validator.decode(chunk, { stream: true }); }
    catch { fail("antigravity_malformed_utf8"); return; }
    buffer += decoder.write(chunk);
    while (!failure && buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      parse(line);
    }
  });
  child.stdout.once("end", () => {
    try { utf8Validator.decode(); }
    catch { fail("antigravity_malformed_utf8"); return; }
    buffer += decoder.end();
    if (buffer.trim()) fail("antigravity_truncated_stream");
  });
  child.stderr.on("data", chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > maxBytes) fail("antigravity_stderr_limit");
  });
  child.once("error", () => fail("antigravity_spawn_failure"));
  child.once("close", () => { if (!settled) fail("antigravity_exited_before_initialize"); });
  child.stdin.on("error", () => { if (!settled) fail("antigravity_stdin_failure"); });
  return {
    initialize() {
      if (started) throw new Error("Antigravity metadata initialization can only be sent once");
      started = true;
      timer = setTimeout(() => fail("antigravity_initialize_timeout"), startupTimeoutMs);
      if (!failure) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: {} } })}\n`);
      return initialized;
    },
    assertHealthy() { if (failure) throw failure; },
    close() { clearTimeout(timer); },
  };
}

function ownedGroupAlive(child) {
  if (!child.pid) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    // Darwin can report EPERM for a group containing only an orphaned zombie.
    // Inspect numeric state only; never read process commands or environments.
    if (error.code === "EPERM" && process.platform === "darwin") {
      const snapshot = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 1_000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C" } });
      if (snapshot.status === 0) {
        const rows = snapshot.stdout.trim().split("\n").filter(Boolean).map(line => line.trim().split(/\s+/));
        if (rows.every(row => row.length === 3 && /^\d+$/.test(row[0]) && /^\d+$/.test(row[1]) && /^[A-Za-z+<>NLsWX-]+$/.test(row[2]))) return rows.some(row => Number(row[1]) === child.pid && !row[2].startsWith("Z"));
      }
    }
    throw new Error(`antigravity_process_group_check_failed:${error.code}`);
  }
}

function signalOwnedGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw new Error(`antigravity_process_group_signal_failed:${error.code}`); }
}

/** Finite shutdown stages also retire descendants after their parent exits. */
export async function stopAntigravityMetadataChild(child, { eofTimeoutMs = 500, terminateTimeoutMs = 500, killTimeoutMs = 500 } = {}) {
  if (!child) return { method: "not-started", exitCode: null, signal: null };
  for (const limit of [eofTimeoutMs, terminateTimeoutMs, killTimeoutMs]) if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new Error("Invalid Antigravity shutdown limits");
  const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once("close", resolve));
  let cleanupUncertainty;
  const groupMayBeAlive = () => {
    try { return ownedGroupAlive(child); }
    catch (error) { cleanupUncertainty = error; return true; }
  };
  child.stdin?.end();
  for (const [method, signal, timeout] of [["eof", null, eofTimeoutMs], ["sigterm", "SIGTERM", terminateTimeoutMs], ["sigkill", "SIGKILL", killTimeoutMs]]) {
    if (!groupMayBeAlive()) return { method, exitCode: child.exitCode, signal: child.signalCode };
    if (signal) {
      try { signalOwnedGroup(child, signal); }
      catch (error) { cleanupUncertainty = error; }
    }
    const deadline = Date.now() + timeout;
    let timer;
    try { await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, timeout); })]); }
    finally { clearTimeout(timer); }
    if (!groupMayBeAlive()) return { method, exitCode: child.exitCode, signal: child.signalCode };
    // A descendant may have closed its inherited pipes. One deadline per stage
    // gives that owned process group time to exit without an idle poll loop.
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(remaining);
    if (!groupMayBeAlive()) return { method, exitCode: child.exitCode, signal: child.signalCode };
  }
  if (cleanupUncertainty) throw cleanupUncertainty;
  throw new Error("antigravity_process_tree_cleanup_unconfirmed");
}

function safeMetadata(result, distribution) {
  if (result.protocolVersion !== 1 || !plainObject(result.agentInfo) || result.agentInfo.name !== "antigravity-acp") throw new Error("antigravity_initialize_identity_mismatch");
  if (result.agentInfo.version !== distribution.version) throw new Error("antigravity_initialize_version_mismatch");
  if (!plainObject(result.agentCapabilities) || !Array.isArray(result.authMethods)) throw new Error("antigravity_malformed_initialize_capabilities");
  const capabilities = result.agentCapabilities;
  if (distribution.patchVersion && capabilities._meta?.antigravity?.paperclipAdmission !== 1) throw new Error("antigravity_native_admission_patch_not_advertised");
  const flag = (object, key) => plainObject(object) && object[key] === true;
  const present = (object, key) => plainObject(object) && Object.hasOwn(object, key) && plainObject(object[key]);
  return {
    schema: "paperclip.antigravity_metadata_probe.v1", version: distribution.version, patchVersion: distribution.patchVersion,
    platform: distribution.platform, architecture: distribution.architecture, archiveSha256: distribution.archiveSha256, vendorClosureSha256: distribution.vendorClosureSha256,
    closureSha256: distribution.closureSha256, admissionSourceSha256: distribution.admissionSourceSha256,
    protocolVersion: 1, agentInfo: { name: "antigravity-acp", title: "Google Antigravity", version: distribution.version },
    agentCapabilities: {
      loadSession: flag(capabilities, "loadSession"),
      promptCapabilities: Object.fromEntries(["image", "audio", "embeddedContext"].map(key => [key, flag(capabilities.promptCapabilities, key)])),
      mcpCapabilities: Object.fromEntries(["http", "sse"].map(key => [key, flag(capabilities.mcpCapabilities, key)])),
      sessionCapabilities: Object.fromEntries(["list", "resume"].map(key => [key, present(capabilities.sessionCapabilities, key)])),
      logout: present(capabilities.auth, "logout"),
      antigravity: { tier: flag(capabilities._meta?.antigravity, "tier"), systemPromptAppend: flag(capabilities._meta?.antigravity?.systemPrompt, "append"), paperclipAdmission: 1 },
    },
    authMethodIds: AUTH_METHOD_IDS.filter(id => result.authMethods.some(method => plainObject(method) && method.id === id)),
    requestsSent: ["initialize"], authenticateRequestsSent: 0, sessionRequestsSent: 0, promptRequestsSent: 0,
    inferenceVerified: false, qualification: "pending",
  };
}

/** Credential-free cache probe. Installation is always a separate explicit action. */
export async function probeAntigravityMetadata(options = {}) {
  const limits = probeLimits(options);
  const distribution = await antigravityDistribution(options.platform, options.architecture);
  const runtimeDirectory = antigravityRuntimeCachePath(distribution.closureSha256, distribution.platform, distribution.architecture, options.home);
  await verifyAntigravityDistribution(runtimeDirectory, distribution);
  const root = await mkdtemp(join(tmpdir(), "paperclip-antigravity-metadata-"));
  let child, rpc, result, shutdown, failure, cleanupFailure;
  try {
    const env = antigravityMetadataEnvironment(root, runtimeDirectory);
    for (const key of ["HOME", "GEMINI_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR"]) await mkdir(env[key], { mode: 0o700 });
    child = spawn(join(runtimeDirectory, distribution.executable), distribution.args, { cwd: root, env, stdio: "pipe", detached: true });
    rpc = createAntigravityMetadataRpc(child, limits);
    result = safeMetadata(await rpc.initialize(), distribution);
  } catch (error) {
    failure = error;
  } finally {
    try { shutdown = await stopAntigravityMetadataChild(child, limits); }
    catch (error) { cleanupFailure = error; }
    finally { rpc?.close(); await rm(root, { recursive: true, force: true }); }
  }
  if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure], `${failure.message}; ${cleanupFailure.message}`);
  if (failure) throw failure;
  if (cleanupFailure) {
    try { rpc?.assertHealthy(); }
    catch (error) { throw new AggregateError([error, cleanupFailure], `${error.message}; ${cleanupFailure.message}`); }
    throw cleanupFailure;
  }
  rpc.assertHealthy();
  return { ...result, shutdown };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  probeAntigravityMetadata().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
