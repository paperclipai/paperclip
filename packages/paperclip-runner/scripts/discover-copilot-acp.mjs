import { StringDecoder } from "node:string_decoder";
// Metadata only. Supply an explicit token; this closed protocol client never prompts.
// Usage: node discover-copilot-acp.mjs <verified-pack> <safe-output.json> [exact-model-id]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const discoveryMethods = new Set(["initialize", "session/new", "session/set_model", "session/set_config_option", "session/close"]);
export function validateDiscoveryModel(model) {
  assert.ok(model === undefined || (typeof model === "string" && model.trim() && model.trim().toLowerCase() !== "auto"), "model must be an exact model ID, not auto");
}

export async function withDiscoveryWorkspace(install, callback, filesystem = { mkdtemp, rm }) {
  const lease = await install.openCommand();
  let root;
  try {
    root = await filesystem.mkdtemp("/tmp/paperclip-copilot-auth-discovery-");
    return await callback(lease, root);
  } finally {
    try { await lease.close(); }
    finally { if (root) await filesystem.rm(root, { recursive: true, force: true }); }
  }
}

export function createDiscoveryRpc(child, { deadlineMs = 25_000, maxBytes = 2_097_152 } = {}) {
  const decoder = new StringDecoder("utf8");
  const pending = new Map(), observedMethods = {};
  let nextId = 0, buffer = "", bytes = 0, failure;
  function fail(code) {
    failure ??= code;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(failure)); }
    pending.clear();
  }
  function fatal(code) { fail(code); child.kill("SIGTERM"); }
  child.once("close", () => fail("provider_exited"));
  child.once("error", () => fail("provider_spawn_failure"));
  child.stdin.on("error", () => fail("provider_stdin_failure"));
  child.stderr.on("data", () => {});
  child.stdout.on("data", chunk => {
    bytes += chunk.length;
    if (bytes > maxBytes) { fatal("provider_wire_limit"); return; }
    buffer += decoder.write(chunk);
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { fatal("provider_malformed_json"); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { fatal("provider_malformed_message"); return; }
      if (message.method) {
        observedMethods[message.method] = (observedMethods[message.method] ?? 0) + 1;
        if (message.id !== undefined) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Discovery does not support inbound methods" } })}\n`);
        continue;
      }
      const item = pending.get(message.id);
      if (item) { clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(new Error(`provider_rpc_error:${message.error.code}`)) : item.resolve(message.result); }
    }
  });
  return {
    observedMethods,
    request(method, params) {
      assert.ok(discoveryMethods.has(method), "metadata discovery cannot send this method");
      if (failure) return Promise.reject(new Error(failure));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`request_deadline:${method}`)); }, deadlineMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    close() { fail("discovery_closed"); },
  };
}

export async function discoverCopilot(packInput, output, model, token) {
  validateDiscoveryModel(model);
  assert.ok(typeof token === "string" && token.trim() && !token.includes("\0"), "explicit Copilot token required");
  const pack = await realpath(packInput);
  const manifest = JSON.parse(await readFile(join(pack, "provider-pack.json"), "utf8"));
  process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT = pack;
  process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST = join(pack, "package.json");
  const { verifyAcpxProfileInstallation, assertAcpxProfileEnvironment } = await import(pathToFileURL(join(pack, "dist/drivers/acpx/profile-installation.js")));
  const { resolveQualifiedAcpxProfile } = await import(pathToFileURL(join(pack, "dist/drivers/acpx/qualified-profiles.js")));
  const { COPILOT_ACP_CLIENT_CAPABILITIES } = await import(pathToFileURL(join(pack, "dist/drivers/acpx/copilot-events.js")));
  assertAcpxProfileEnvironment("copilot", { COPILOT_GITHUB_TOKEN: token });
  const install = await verifyAcpxProfileInstallation(resolveQualifiedAcpxProfile("copilot", model ?? "discovery-unselected"));
  return withDiscoveryWorkspace(install, async (lease, root) => {
    const env = { PATH: "/usr/bin:/bin", COPILOT_GITHUB_TOKEN: token, COPILOT_AUTO_UPDATE: "false", COPILOT_ALLOW_ALL: "false", NO_COLOR: "1" };
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "COPILOT_HOME", "COPILOT_CACHE_HOME"]) {
      env[key] = join(root, key.toLowerCase()); await mkdir(env[key], { mode: 0o700 });
    }
    await writeFile(join(env.COPILOT_HOME, "config.json"), JSON.stringify({ autoUpdate: false, trustedFolders: [], disableAllHooks: true, memory: false, ide: { autoConnect: false } }), { mode: 0o600 });
    let child, exitPromise, rpc;
    try {
      child = lease.spawn([], { cwd: root, env, stdio: "pipe" });
      exitPromise = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
      rpc = createDiscoveryRpc(child);
      const initialized = await rpc.request("initialize", { protocolVersion: 1, clientInfo: { name: "paperclip-authenticated-model-discovery", version: "1" }, clientCapabilities: COPILOT_ACP_CLIENT_CAPABILITIES });
      const opened = await rpc.request("session/new", { cwd: root, mcpServers: [] });
      const safe = { schema: "paperclip.copilot-authenticated-discovery/v1", observedAt: new Date().toISOString(), harnessVersion: initialized.agentInfo?.version,
        sourceRevision: manifest.payload.runnerSourceRevision, providerPackDigest: manifest.digest, profileDigest: install.commandDigest,
        agentCapabilities: initialized.agentCapabilities, models: opened.models ?? null, configOptions: opened.configOptions ?? [], promptSent: false,
        promptRequestsSent: 0, inferenceVerified: false, qualification: "pending; metadata discovery only", observedMethods: rpc.observedMethods };
      if (model) {
        assert.ok(opened.models?.availableModels?.some(value => value.modelId === model), "requested exact model must be advertised");
        const selected = await rpc.request("session/set_model", { sessionId: opened.sessionId, modelId: model });
        const configured = await rpc.request("session/set_config_option", { sessionId: opened.sessionId, configId: "model", value: model });
        assert.equal(configured.configOptions?.find(option => option.id === "model")?.currentValue, model);
        safe.modelSelection = { requestedModel: model, succeeded: true, response: selected, configEcho: configured };
      }
      try { await rpc.request("session/close", { sessionId: opened.sessionId }); safe.sessionClosed = true; }
      catch { safe.sessionClosed = false; }
      const text = `${JSON.stringify(safe, null, 2)}\n`;
      assert.ok(!text.includes(token)); assert.ok(!text.includes(opened.sessionId)); assert.ok(!text.includes(root));
      await writeFile(output, text, { mode: 0o600 });
      return { output, sha256: createHash("sha256").update(text).digest("hex"), harnessVersion: safe.harnessVersion, modelCount: safe.models?.availableModels?.length ?? 0,
        configOptionIds: safe.configOptions.map(value => value.id), modelIds: safe.models?.availableModels?.map(value => value.modelId) ?? [], promptSent: false };
    } finally {
      rpc?.close();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        const term = setTimeout(() => child.kill("SIGTERM"), 1_000), kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
        try { await exitPromise; } finally { clearTimeout(term); clearTimeout(kill); }
      }
    }
  });
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(await discoverCopilot(process.argv[2], process.argv[3], process.argv[4], process.env.COPILOT_GITHUB_TOKEN)));
}
