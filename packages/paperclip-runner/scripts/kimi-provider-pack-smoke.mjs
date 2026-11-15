import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function assertKimiProviderPackInventory(manifest, profile, closures, platform = process.platform, architecture = process.arch) {
  assert.equal(manifest.schema, "paperclip-runner/remote-provider-pack/v1");
  assert.deepEqual(manifest.payload.target, { platform, architecture });
  const target = `${platform}-${architecture}`;
  assert.ok(["darwin-arm64", "linux-x64"].includes(target));
  const pending = profile.qualificationStatus === "pending";
  const identity = pending ? manifest.payload.candidateProviders?.kimi : manifest.payload.providers?.kimi;
  assert.equal(pending ? manifest.payload.providers?.kimi : manifest.payload.candidateProviders?.kimi, undefined);
  assert.equal(identity?.qualification, pending ? "pending" : "qualified");
  assert.equal(identity.version, profile.agentServerVersion);
  assert.equal(identity.path, `provider-assets/kimi/${target}`);
  assert.equal(identity.profileDigest, profile.commandDigest);
  assert.match(closures[target] ?? "", /^[a-f0-9]{64}$/);
  assert.equal(identity.closureDigest, `sha256:${closures[target]}`);
  assert.match(identity.sha256, /^sha256:[a-f0-9]{64}$/);
  return identity;
}

export async function smokeKimiProviderPack(directory) {
  const pack = await realpath(resolve(directory));
  const manifest = JSON.parse(await readFile(join(pack, "provider-pack.json"), "utf8"));
  assert.equal(manifest.schema, "paperclip-runner/remote-provider-pack/v1");
  assert.equal(manifest.payload.target.platform, process.platform);
  assert.equal(manifest.payload.target.architecture, process.arch);
  if (process.env.PAPERCLIP_EXPECTED_SOURCE_REVISION) assert.equal(manifest.payload.runnerSourceRevision, process.env.PAPERCLIP_EXPECTED_SOURCE_REVISION);
  const load = path => import(pathToFileURL(join(pack, "dist/drivers/acpx", path)));
  const [{ verifyKimiInstallation }, { QUALIFIED_ACPX_PROFILES }, { kimiManagedConfiguration }, { kimiInstructionBinding }, { KIMI_DISTRIBUTION_CLOSURE_SHA256 }] = await Promise.all([
    load("kimi-installation.js"), load("qualified-profiles.js"), load("kimi-config.js"), load("kimi-instructions.js"), load("kimi-closure-pins.js"),
  ]);
  const provider = assertKimiProviderPackInventory(manifest, QUALIFIED_ACPX_PROFILES.kimi, KIMI_DISTRIBUTION_CLOSURE_SHA256);
  const keys = ["PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", "PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST"];
  const previous = keys.map(key => process.env[key]);
  process.env[keys[0]] = pack; process.env[keys[1]] = join(pack, "package.json");
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-kimi-pack-smoke-")));
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home); await mkdir(workspace);
  const model = "kimi-for-coding";
  const binding = kimiInstructionBinding("Do not call a model during this installed-package smoke. Exact suffix: café.\n");
  await writeFile(join(home, "config.toml"), kimiManagedConfiguration(model), { mode: 0o600 });
  const active = new Set(); let sequence = 0;
  try {
    const installation = await verifyKimiInstallation(QUALIFIED_ACPX_PROFILES.kimi);
    const connect = async () => {
      const lease = await installation.openCommand();
      const child = lease.spawn([], { cwd: workspace, stdio: "pipe", env: {
        PATH: "/usr/bin:/bin", LANG: "C.UTF-8", KIMI_CODE_HOME: home,
        KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_API_KEY: "paperclip-offline-placeholder",
        PAPERCLIP_KIMI_INSTRUCTIONS: binding.payload, CI: "1", NO_COLOR: "1", TERM: "dumb",
      } });
      const closed = once(child, "close"), pending = new Map();
      let buffer = "", bytes = 0;
      const fail = error => { for (const request of pending.values()) request.reject(error); pending.clear(); };
      child.on("error", fail); child.on("close", () => fail(new Error("Kimi exited with a pending ACP request")));
      child.stderr.resume();
      child.stdout.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { fail(new Error("Kimi ACP output exceeded its package smoke bound")); return; }
        buffer += chunk.toString("utf8");
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let value;
          try { value = JSON.parse(line); } catch { fail(new Error("Kimi emitted malformed ACP JSON")); return; }
          const request = pending.get(value.id);
          if (request && value.method === undefined) {
            pending.delete(value.id);
            if (value.error) request.reject(new Error(`Kimi rejected ACP request (${value.error.code})`));
            else request.resolve(value.result);
          }
        }
      });
      const request = (method, params) => new Promise((accept, reject) => {
        const id = sequence++;
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Kimi ${method} timed out`)); }, 15_000);
        const settle = callback => value => { clearTimeout(timeout); callback(value); };
        pending.set(id, { resolve: settle(accept), reject: settle(reject) });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
      let closing;
      const close = () => closing ??= (async () => {
        const started = Date.now(); child.stdin.end();
        const term = setTimeout(() => child.kill("SIGTERM"), 4_000), kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
        try {
          const [code, signal] = await closed;
          assert.equal(code, 0, "Kimi did not exit cleanly after EOF"); assert.equal(signal, null);
          return Date.now() - started;
        } finally { clearTimeout(term); clearTimeout(kill); await lease.close(); active.delete(close); }
      })();
      active.add(close);
      const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "paperclip-provider-pack-smoke", version: "1" } });
      assert.equal(initialized.agentInfo?.version, "2.3.3");
      return { request, close };
    };
    const assertBinding = (result, sessionId) => {
      const ack = result._meta?.paperclipKimiInstructions;
      assert.equal(ack?.sessionId, sessionId); assert.equal(ack.digest, binding.digest); assert.equal(ack.byteLength, binding.byteLength);
      assert.match(ack.effectiveDigest, /^sha256:[a-f0-9]{64}$/);
    };
    const first = await connect();
    const created = await first.request("session/new", { cwd: workspace, mcpServers: [] });
    assertBinding(created, created.sessionId);
    const selected = await first.request("session/set_config_option", { sessionId: created.sessionId, configId: "model", value: model });
    assert.equal(selected.configOptions.find(option => option.id === "model").currentValue, model);
    const createExitMs = await first.close();
    const second = await connect();
    const loaded = await second.request("session/load", { sessionId: created.sessionId, cwd: workspace, mcpServers: [] });
    assertBinding(loaded, created.sessionId);
    assert.equal(loaded.configOptions.find(option => option.id === "model").currentValue, model);
    const loadExitMs = await second.close();
    return { schema: "paperclip.kimi-provider-pack-smoke.v1", sourceRevision: manifest.payload.runnerSourceRevision, providerPackDigest: manifest.digest,
      platform: process.platform, architecture: process.arch, runtimeVersion: "2.3.3", profileDigest: provider.profileDigest, closureDigest: provider.closureDigest,
      createAcknowledged: true, loadAcknowledged: true, model, createExitMs, loadExitMs, providerPrompts: 0, providerCredentials: false,
      qualification: "installed runtime only; no model entitlement or task completion" };
  } finally {
    try { await Promise.all([...active].map(close => close())); }
    finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); await rm(root, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/kimi-provider-pack-smoke.mjs /absolute/installed-provider-pack");
  smokeKimiProviderPack(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
