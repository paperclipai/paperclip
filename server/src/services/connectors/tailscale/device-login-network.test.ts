import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTailscaleNetworkManager } from "./network.js";
import { parseTailscaleLoginStatus } from "./device-login-status.js";

describe("Tailscale interactive device enrollment", () => {
  let dir: string;
  let manager: ReturnType<typeof createTailscaleNetworkManager>;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ts-login-test-"));
    await fs.writeFile(path.join(dir, "daemon"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(process.argv.find(arg => arg.startsWith('--socket=')).slice(9));
fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    await fs.writeFile(path.join(dir, "cli"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dir = path.dirname(args[0].slice(9));
const statePath = path.join(dir, 'state');
if (!fs.existsSync(path.join(dir, 'pid'))) process.exit(4);
let state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
if (args[1] === 'up') {
  if (args.some(arg => arg.startsWith('--auth-key'))) process.exit(5);
  if (state.BackendState === 'Running') process.exit(0);
  state = { MachineKey: state.MachineKey || path.basename(dir), BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/fixture' };
  fs.writeFileSync(statePath, JSON.stringify(state));
  fs.watch(dir, () => {
    if (JSON.parse(fs.readFileSync(statePath, 'utf8')).BackendState === 'Running') process.exit(0);
  });
} else if (args[1] === 'status') console.log(JSON.stringify(state));
`, { mode: 0o700 });
    manager = createTailscaleNetworkManager({ daemon: path.join(dir, "daemon"), cli: path.join(dir, "cli") });
  });
  afterEach(async () => { await manager.close(); await fs.rm(dir, { recursive: true, force: true }); });

  const emptyState = "paperclip-tailscale-state-v1:" + Buffer.from("{}").toString("base64");
  it("returns a login URL without a key, persists consent, and restores the same device", async () => {
    let credential = emptyState;
    const authorized = vi.fn().mockResolvedValue(undefined);
    const input = { identity: "company:secret", credential, persist: async (value: string) => { credential = value; },
      login: { expiresAt: Date.now() + 60_000, onAuthorized: authorized, onFailure: vi.fn() } };
    const socket = await manager.connect(input);
    expect(await manager.loginStatus(input.identity)).toEqual({ status: "authorizing", authorizationUrl: "https://login.tailscale.com/a/fixture" });
    const statePath = path.join(path.dirname(socket), "state");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(credential).not.toBe(emptyState);
    expect(authorized).not.toHaveBeenCalled();
    await fs.writeFile(statePath, JSON.stringify({ ...state, BackendState: "Running", AuthURL: "" }));
    await vi.waitFor(() => expect(authorized).toHaveBeenCalledOnce());
    await manager.close();
    const restored = await manager.connect({ identity: input.identity, credential, persist: input.persist });
    expect(JSON.parse(await fs.readFile(path.join(path.dirname(restored), "state"), "utf8")).MachineKey).toBe(state.MachineKey);
  });

  it("reports device approval separately and cancels pending enrollment", async () => {
    const authorized = vi.fn();
    const input = { identity: "awaiting-approval", credential: emptyState, persist: vi.fn(),
      login: { expiresAt: Date.now() + 60_000, onAuthorized: authorized, onFailure: vi.fn() } };
    const socket = await manager.connect(input);
    const statePath = path.join(path.dirname(socket), "state");
    await fs.writeFile(statePath, JSON.stringify({ BackendState: "NeedsMachineAuth" }));
    expect(await manager.loginStatus(input.identity)).toEqual({ status: "needs_approval" });
    await manager.disconnect(input.identity);
    expect(await manager.loginStatus(input.identity)).toBeNull();
    expect(authorized).not.toHaveBeenCalled();
    expect(input.login.onFailure).not.toHaveBeenCalled();
    await expect(fs.stat(path.dirname(socket))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops an expired sign-in without accepting late consent", async () => {
    const authorized = vi.fn();
    const failure = vi.fn().mockResolvedValue(undefined);
    const socket = await manager.connect({ identity: "expires", credential: emptyState, persist: vi.fn(),
      login: { expiresAt: Date.now() + 1200, onAuthorized: authorized, onFailure: failure } });
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce(), { timeout: 4000 });
    await vi.waitFor(async () => expect(await manager.loginStatus("expires")).toBeNull());
    expect(authorized).not.toHaveBeenCalled();
    await expect(fs.stat(path.dirname(socket))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets secret deletion cancel a blocked credential save", async () => {
    let saveEntered!: () => void, releaseSave!: () => void;
    const entered = new Promise<void>(resolve => { saveEntered = resolve; });
    const blocked = new Promise<void>(resolve => { releaseSave = resolve; });
    const connecting = manager.connect({ identity: "deleted-secret", credential: emptyState,
      persist: async () => { saveEntered(); await blocked; },
      login: { expiresAt: Date.now() + 60_000, onAuthorized: vi.fn(), onFailure: vi.fn() } });
    const settled = connecting.catch(() => undefined);
    try {
      await entered;
      await manager.disconnect("deleted-secret", { discardState: true });
      await expect(connecting).rejects.toThrow("Tailscale");
      expect(await manager.loginStatus("deleted-secret")).toBeNull();
    } finally { releaseSave(); await settled; }
  });

  it.each(["http://login.tailscale.com/a/fixture", "https://attacker.example/a/fixture", "https://login.tailscale.com/a/fixture?redirect=elsewhere",
    "https://user:password@login.tailscale.com/a/fixture", "https://login.tailscale.com/a/fixture#token"])("rejects an unexpected sign-in address: %s", AuthURL => {
    expect(() => parseTailscaleLoginStatus({ BackendState: "NeedsLogin", AuthURL })).toThrow("Invalid Tailscale");
  });
});
