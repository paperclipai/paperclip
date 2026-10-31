import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const target = `${process.platform}-${process.arch}`;
const enabled = process.env.PAPERCLIP_TEST_KIMI_INSTALLED_RUNTIME === "1";

test("real installed Kimi acknowledges instructions/model/create/load and exits after EOF without model prompts", { skip: !enabled && "Set PAPERCLIP_TEST_KIMI_INSTALLED_RUNTIME=1 after paperclipai runtime setup kimi; uses no provider credential or model calls", timeout: 45_000 }, async t => {
  const assets = join(packageRoot, "provider-assets/kimi", target);
  try { await access(join(assets, "native-closure.json")); }
  catch (error) { if (error.code === "ENOENT") { t.skip(`Pinned Kimi assets are not installed for ${target}; run paperclipai runtime setup kimi`); return; } throw error; }
  const { tsImport } = await import("tsx/esm/api");
  const { verifyKimiInstallation } = await tsImport("../src/drivers/acpx/kimi-installation.ts", import.meta.url);
  const { QUALIFIED_ACPX_PROFILES } = await tsImport("../src/drivers/acpx/qualified-profiles.ts", import.meta.url);
  const { kimiManagedConfiguration } = await tsImport("../src/drivers/acpx/kimi-config.ts", import.meta.url);
  const { kimiInstructionBinding } = await tsImport("../src/drivers/acpx/kimi-instructions.ts", import.meta.url);
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-kimi-installed-runtime-")));
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home); await mkdir(workspace);
  const model = "kimi-for-coding";
  await writeFile(join(home, "config.toml"), kimiManagedConfiguration(model), { mode: 0o600 });
  const binding = kimiInstructionBinding("Do not invoke a model during this package protocol check. Keep this exact suffix: café.\n");
  const keys = ["PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", "PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST"];
  const previous = keys.map(key => process.env[key]);
  process.env[keys[0]] = resolve(packageRoot); process.env[keys[1]] = join(resolve(packageRoot), "package.json");
  const connections = new Set();
  let sequence = 0;
  try {
    const installation = await verifyKimiInstallation(QUALIFIED_ACPX_PROFILES.kimi);
    const connect = async () => {
      const lease = await installation.openCommand();
      const child = lease.spawn([], { cwd: workspace, env: {
        PATH: "/usr/bin:/bin", LANG: "C.UTF-8", KIMI_CODE_HOME: home,
        KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_API_KEY: "paperclip-offline-placeholder",
        PAPERCLIP_KIMI_INSTRUCTIONS: binding.payload, CI: "1", NO_COLOR: "1", TERM: "dumb",
      }, stdio: "pipe" });
      let buffer = "", total = 0;
      const pending = new Map();
      const closed = once(child, "close");
      const fail = error => { for (const item of pending.values()) item.reject(error); pending.clear(); };
      child.on("error", fail);
      child.on("close", () => fail(new Error("Kimi exited with an unresolved ACP request")));
      child.stderr.resume();
      child.stdout.on("data", chunk => {
        total += chunk.length;
        if (total > 1024 * 1024) { fail(new Error("Kimi ACP output exceeded the package smoke bound")); return; }
        buffer += chunk.toString("utf8");
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { fail(new Error("Kimi emitted malformed ACP JSON")); return; }
          const item = pending.get(message.id);
          if (item && message.method === undefined) {
            pending.delete(message.id);
            if (message.error) item.reject(new Error(`Kimi rejected ACP request (${message.error.code})`));
            else item.resolve(message.result);
          }
        }
      });
      const request = (method, params) => new Promise((accept, reject) => {
        const id = sequence++;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Kimi ${method} timed out`)); }, 10_000);
        const settle = callback => value => { clearTimeout(timer); callback(value); };
        pending.set(id, { resolve: settle(accept), reject: settle(reject) });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
      let closePromise;
      const close = () => closePromise ??= (async () => {
        const started = Date.now();
        child.stdin.end();
        const term = setTimeout(() => child.kill("SIGTERM"), 4_000);
        const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
        try { const [code, signal] = await closed; return { code, signal, elapsedMs: Date.now() - started }; }
        finally { clearTimeout(term); clearTimeout(kill); await lease.close(); connections.delete(close); }
      })();
      connections.add(close);
      const initialize = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "paperclip-installed-package-test", version: "1" } });
      assert.equal(initialize.agentInfo.version, "2.3.3");
      return { request, close };
    };
    const first = await connect();
    const created = await first.request("session/new", { cwd: workspace, mcpServers: [] });
    const assertBinding = (result, sessionId) => {
      const ack = result._meta.paperclipKimiInstructions;
      assert.equal(ack.sessionId, sessionId); assert.equal(ack.digest, binding.digest); assert.equal(ack.byteLength, binding.byteLength);
      assert.match(ack.effectiveDigest, /^sha256:[a-f0-9]{64}$/);
    };
    assertBinding(created, created.sessionId);
    const selected = await first.request("session/set_config_option", { sessionId: created.sessionId, configId: "model", value: model });
    assert.equal(selected.configOptions.find(option => option.id === "model").currentValue, model);
    const firstClose = await first.close(); assert.equal(firstClose.code, 0); assert.equal(firstClose.signal, null);
    const second = await connect();
    const loaded = await second.request("session/load", { sessionId: created.sessionId, cwd: workspace, mcpServers: [] });
    assertBinding(loaded, created.sessionId);
    assert.equal(loaded.configOptions.find(option => option.id === "model").currentValue, model);
    const secondClose = await second.close(); assert.equal(secondClose.code, 0); assert.equal(secondClose.signal, null);
    t.diagnostic(`Kimi 2.3.3 ${target}: create/load/model bound; EOF exits ${firstClose.elapsedMs}ms/${secondClose.elapsedMs}ms; zero session/prompt calls`);
  } finally {
    try { await Promise.all([...connections].map(close => close())); }
    finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); await rm(root, { recursive: true, force: true }); }
  }
});
