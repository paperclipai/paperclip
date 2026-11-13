import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTailscaleNetworkManager } from "./tailscale-network.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Tailscale environment network process boundary", () => {
  let dir: string;
  let manager: ReturnType<typeof createTailscaleNetworkManager>;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-tailnet-test-"));
    const daemon = path.join(dir, "tailscaled");
    const cli = path.join(dir, "tailscale");
    await fs.writeFile(daemon, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const socket = process.argv.find(arg => arg.startsWith('--socket=')).slice('--socket='.length);
fs.writeFileSync(path.join(path.dirname(socket), 'pid'), String(process.pid), { mode: 0o600 });
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    await fs.writeFile(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dir = path.dirname(args[0].slice('--socket='.length));
const state = path.join(dir, 'state');
fs.appendFileSync(${JSON.stringify(path.join(dir, "calls"))}, JSON.stringify(args) + '\\n');
if (!fs.existsSync(path.join(dir, 'pid'))) process.exit(4);
if (args[1] === 'up') {
  const key = args.find(a => a.startsWith('--auth-key=file:'));
  if (key) {
    const file = key.slice('--auth-key=file:'.length);
    if ((fs.statSync(file).mode & 0o777) !== 0o600) process.exit(2);
    if (!fs.readFileSync(file, 'utf8').startsWith('tskey-auth-')) process.exit(3);
    fs.writeFileSync(state, JSON.stringify({ MachineKey: 'fixture-node-state' }), { mode: 0o600 });
  }
} else if (args[1] === 'status') {
  console.log(JSON.stringify({ BackendState: fs.existsSync(state) ? 'Running' : 'NeedsLogin' }));
}
`, { mode: 0o700 });
    manager = createTailscaleNetworkManager({ daemon, cli });
  });
  afterEach(async () => { await manager.close(); await fs.rm(dir, { recursive: true, force: true }); });

  it("uses a private key file, coalesces connections, and saves node state before use", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const input = { identity: "company:connection", credential: "tskey-auth-fixture", persist };
    const [socket, sameSocket] = await Promise.all([manager.connect(input), manager.connect(input)]);
    expect(socket).toBe(sameSocket);
    expect((await fs.stat(path.dirname(socket))).mode & 0o777).toBe(0o700);
    expect(persist).toHaveBeenCalledOnce();
    const state = persist.mock.calls[0][0] as string;
    expect(state).toMatch(/^paperclip-tailscale-state-v1:/);
    expect(Buffer.from(state.split(":")[1], "base64").toString()).toContain("fixture-node-state");
    expect(await manager.connect({ ...input, credential: state })).toBe(socket);
    const calls = await fs.readFile(path.join(dir, "calls"), "utf8");
    expect(calls).not.toContain(input.credential);
    expect(calls).toContain("--auth-key=file:");
    await expect(fs.stat(path.join(path.dirname(socket), "key"))).rejects.toThrow();
    await manager.close();
    await expect(fs.stat(path.dirname(socket))).rejects.toThrow();
  });

  it("restores an identity after a process restart without using the single-use key again", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    await manager.connect({ identity: "same-connection", credential: "tskey-auth-fixture", persist });
    const credential = persist.mock.calls[0][0] as string;
    await manager.close();
    await fs.writeFile(path.join(dir, "calls"), "");
    await manager.connect({ identity: "same-connection", credential, persist });
    expect(await fs.readFile(path.join(dir, "calls"), "utf8")).not.toContain("--auth-key");
  });

  it("fails closed if state cannot be stored, cleans up, and allows retry", async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error("vault unavailable")).mockResolvedValue(undefined);
    const input = { identity: "retry", credential: "tskey-auth-fixture", persist };
    await expect(manager.connect(input)).rejects.toThrow("Tailscale could not connect");
    const calls = (await fs.readFile(path.join(dir, "calls"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    await expect(fs.stat(path.dirname(calls[0][0].slice("--socket=".length)))).rejects.toThrow();
    await expect(manager.connect(input)).resolves.toContain("/paperclip-ts-");
  });

  it("does not mix identities and never exposes a failed credential", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const one = await manager.connect({ identity: "company-one", credential: "tskey-auth-fixture", persist });
    const two = await manager.connect({ identity: "company-two", credential: "tskey-auth-fixture", persist });
    expect(one).not.toBe(two);
    await expect(manager.connect({ identity: "invalid", credential: "sensitive-invalid-key", persist })).rejects.toThrow("Tailscale could not connect");
    await expect(manager.connect({ identity: "invalid", credential: "tskey-auth-fixed", persist })).resolves.toContain("/paperclip-ts-");
  });

  it("handles a missing daemon without leaving a pending connection", async () => {
    const missing = createTailscaleNetworkManager({ daemon: path.join(dir, "missing") });
    await expect(missing.connect({ identity: "missing", credential: "tskey-auth-fixture", persist: async () => undefined })).rejects.toThrow("Tailscale could not connect");
    await missing.close();
  });

  it("cancels startup before the daemon is launched", async () => {
    const connecting = manager.connect({ identity: "cancel", credential: "tskey-auth-fixture", persist: async () => undefined });
    const assertion = expect(connecting).rejects.toThrow("Tailscale could not connect");
    await manager.close();
    await assertion;
    await expect(fs.stat(path.join(dir, "calls"))).rejects.toThrow();
  });

  it("waits for a stopped daemon's state write before reconnecting with current credentials", async () => {
    const saving = deferred();
    const release = deferred();
    let credential = "tskey-auth-fixture";
    let writes = 0;
    const persist = vi.fn(async (value: string) => {
      writes += 1;
      if (writes === 2) {
        saving.resolve();
        await release.promise;
      }
      credential = value;
    });
    const reload = vi.fn(async () => credential);
    const input = { identity: "closing", credential, persist, reload };
    const socket = await manager.connect(input);
    const staleCredential = credential;
    await fs.writeFile(path.join(path.dirname(socket), "state"), JSON.stringify({ MachineKey: "rotated-fixture-state" }));
    const pid = Number(await fs.readFile(path.join(path.dirname(socket), "pid"), "utf8"));
    process.kill(pid, "SIGTERM");
    await saving.promise;

    let settled = false;
    const reconnect = manager.connect({ ...input, credential: staleCredential }).then(value => { settled = true; return value; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally { release.resolve(); }
    const nextSocket = await reconnect;
    expect(nextSocket).not.toBe(socket);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await fs.readFile(path.join(path.dirname(nextSocket), "state"), "utf8"))).toEqual({ MachineKey: "rotated-fixture-state" });
    await expect(fs.stat(path.dirname(socket))).rejects.toThrow();
  });

  it("coalesces callers whose credential was refreshed while startup was pending", async () => {
    const loading = deferred();
    const release = deferred();
    const credential = "paperclip-tailscale-state-v1:" + Buffer.from(JSON.stringify({ MachineKey: "current-fixture-state" })).toString("base64");
    const reload = vi.fn(async () => { loading.resolve(); await release.promise; return credential; });
    const input = { identity: "refresh-startup", credential: "tskey-auth-fixture", reload, persist: async () => undefined };
    const first = manager.connect(input);
    await loading.promise;
    const second = manager.connect({ ...input, credential });
    const pair = Promise.all([first, second]);
    release.resolve();
    const [one, two] = await pair;
    expect(one).toBe(two);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("cancels startup while the credential provider is still loading", async () => {
    const loading = deferred();
    const release = deferred();
    const connecting = manager.connect({ identity: "cancel-load", credential: "tskey-auth-fixture", persist: async () => undefined,
      reload: async () => { loading.resolve(); await release.promise; return "tskey-auth-fixture"; } });
    const assertion = expect(connecting).rejects.toThrow("Tailscale could not connect");
    await loading.promise;
    await manager.close();
    release.resolve();
    await assertion;
    await expect(fs.stat(path.join(dir, "calls"))).rejects.toThrow();
  });

  it("does not restart a queued reconnect after manager shutdown", async () => {
    const saving = deferred();
    const release = deferred();
    let writes = 0;
    const persist = vi.fn(async () => { writes += 1; if (writes === 2) { saving.resolve(); await release.promise; } });
    const input = { identity: "stop-reconnect", credential: "tskey-auth-fixture", persist };
    const socket = await manager.connect(input);
    await fs.writeFile(path.join(path.dirname(socket), "state"), JSON.stringify({ MachineKey: "changed-fixture-state" }));
    process.kill(Number(await fs.readFile(path.join(path.dirname(socket), "pid"), "utf8")), "SIGTERM");
    await saving.promise;
    const assertion = expect(manager.connect(input)).rejects.toThrow("Tailscale stopped");
    const stopping = manager.close();
    release.resolve();
    await stopping;
    await assertion;
    const calls = (await fs.readFile(path.join(dir, "calls"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(args => args[1] === "up")).toHaveLength(1);
  });
});
