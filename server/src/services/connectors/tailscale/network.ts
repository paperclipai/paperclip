import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseTailscaleLoginStatus, type TailscaleLoginStatus } from "./device-login-status.js";

const exec = promisify(execFile);
const STATE_PREFIX = "paperclip-tailscale-state-v1:";
const MAX_STATE_BYTES = 2 * 1024 * 1024;

export function isTailscaleNodeState(value: string): boolean {
  return value.startsWith(STATE_PREFIX);
}

type DeviceLogin = { expiresAt: number; onAuthorized: () => Promise<void>; onFailure: () => Promise<void> };
type Connection = { credential: string; savedCredential?: string; child?: ChildProcess; loginChild?: ChildProcess;
  loginStatus?: () => Promise<TailscaleLoginStatus>; closed: boolean; discardState: AbortController;
  closing?: Promise<void>; ready: Promise<string>; close: () => Promise<void> };

export function createTailscaleNetworkManager(commands: { cli?: string; daemon?: string } = {}) {
  const connections = new Map<string, Connection>();
  let generation = 0;

  async function connect(input: {
    identity: string;
    credential: string;
    persist: (credential: string) => Promise<void>;
    reload?: () => Promise<string>;
    login?: DeviceLogin;
  }, expectedGeneration = generation): Promise<string> {
    if (expectedGeneration !== generation) throw new Error("Tailscale stopped");
    const existing = connections.get(input.identity);
    if (existing?.closing) { await existing.closing; return connect(input, expectedGeneration); }
    if (existing && (existing.credential === input.credential || existing.savedCredential === input.credential)) return existing.ready;
    if (existing && !existing.savedCredential) { await existing.ready.catch(() => undefined); return connect(input, expectedGeneration); }
    if (existing) {
      const credential = input.reload ? await input.reload() : input.credential;
      if (expectedGeneration !== generation) throw new Error("Tailscale stopped");
      if (connections.get(input.identity) !== existing || existing.closing) {
        return connect({ ...input, credential }, expectedGeneration);
      }
      if (existing.credential === credential || existing.savedCredential === credential) return existing.ready;
      await existing.close();
      return connect({ ...input, credential }, expectedGeneration);
    }

    const connection: Connection = {
      credential: input.credential,
      closed: false,
      discardState: new AbortController(),
      ready: Promise.resolve(""),
      close: async () => {
        connection.closed = true;
        if (connections.get(input.identity) === connection) connections.delete(input.identity);
      },
    };
    connections.set(input.identity, connection);
    connection.ready = (async () => {
      const credential = input.reload ? await input.reload() : input.credential;
      if (connection.closed) throw new Error("Tailscale stopped");
      connection.credential = credential;
      return start({ ...input, credential }, connection);
    })().catch(async () => {
      await connection.close().catch(() => undefined);
      if (connections.get(input.identity) === connection) connections.delete(input.identity);
      throw new Error("Tailscale could not connect. Reconnect Tailscale and check its access policy.");
    });
    return connection.ready;
  }

  async function start(input: { identity: string; credential: string; persist: (credential: string) => Promise<void>; login?: DeviceLogin }, connection: Connection) {
    const restored = isTailscaleNodeState(input.credential);
    const state = restored ? Buffer.from(input.credential.slice(STATE_PREFIX.length), "base64") : null;
    if (state && (state.length > MAX_STATE_BYTES || !state.length)) throw new Error("Invalid state");
    if (state) JSON.parse(state.toString("utf8"));
    if (!restored && (!input.credential || input.credential.length > 4096 || /\s/.test(input.credential))) throw new Error("Invalid authorization token");

    let dir: string | undefined;
    let statePath: string | undefined;
    let saving = Promise.resolve();
    const persist = async (value: string) => {
      const signal = connection.discardState.signal;
      if (signal.aborted) return;
      let discard!: () => void;
      const discarded = new Promise<void>(resolve => { discard = resolve; });
      signal.addEventListener("abort", discard, { once: true });
      try {
        await Promise.race([input.persist(value), discarded]);
        if (!signal.aborted) connection.savedCredential = value;
      } finally { signal.removeEventListener("abort", discard); }
    };
    const save = () => {
      const pending = saving.then(async () => {
        if (connection.discardState.signal.aborted || !statePath) return;
        const bytes = await fs.readFile(statePath);
        if (!bytes.length || bytes.length > MAX_STATE_BYTES) throw new Error("Invalid state");
        const next = STATE_PREFIX + bytes.toString("base64");
        if (next !== connection.savedCredential) {
          await persist(next);
        }
      });
      saving = pending.catch(() => undefined);
      return pending;
    };
    connection.close = () => connection.closing ??= (async () => {
      connection.closed = true;
      connection.loginChild?.kill("SIGKILL");
      const child = connection.child;
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 2_000);
          child.once("exit", () => { clearTimeout(timeout); resolve(); });
          child.kill("SIGTERM");
        });
      }
      try {
        await saving;
        if (!connection.discardState.signal.aborted && connection.savedCredential && statePath) {
          const bytes = await fs.readFile(statePath);
          if (bytes.length && bytes.length <= MAX_STATE_BYTES) {
            const latest = STATE_PREFIX + bytes.toString("base64");
            if (latest !== connection.savedCredential) {
              await persist(latest);
            }
          }
        }
      } finally {
        if (dir) await fs.rm(dir, { recursive: true, force: true });
        if (connections.get(input.identity) === connection) connections.delete(input.identity);
      }
    })();
    dir = await fs.mkdtemp(path.join(os.platform() === "win32" ? os.tmpdir() : "/tmp", "paperclip-ts-"));
    if (connection.closed) { await fs.rm(dir, { recursive: true, force: true }); throw new Error("Tailscale stopped"); }
    await fs.chmod(dir, 0o700);
    const socket = path.join(dir, "socket");
    statePath = path.join(dir, "state");
    const keyPath = path.join(dir, "key");
    if (state) await fs.writeFile(statePath, state, { mode: 0o600 });
    if (connection.closed) throw new Error("Tailscale stopped");
    const daemonCommand = commands.daemon ?? (process.env.PAPERCLIP_TAILSCALED?.trim() || "tailscaled");
    const cliCommand = commands.cli ?? (process.env.PAPERCLIP_TAILSCALE_CLI?.trim() || "tailscale");
    const child = spawn(daemonCommand, ["--tun=userspace-networking", "--port=0", `--socket=${socket}`, `--state=${statePath}`, `--statedir=${dir}`], {
      stdio: "ignore",
    });
    connection.child = child;
    let failed = false;
    child.once("error", () => { failed = true; });
    child.once("exit", () => { failed = true; void connection.close().catch(() => undefined); });
    const cli = async (args: string[], timeout = 5_000) => {
      if (failed || connection.closed) throw new Error("Tailscale stopped");
      return exec(cliCommand, [`--socket=${socket}`, ...args], { timeout, maxBuffer: MAX_STATE_BYTES });
    };
    const deadline = Date.now() + 5_000;
    for (;;) {
      try { await cli(["status", "--json"]); break; } catch {
        if (failed || connection.closed || Date.now() >= deadline) throw new Error("Tailscale startup timed out");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (input.login) {
      const login = input.login;
      const remaining = login.expiresAt - Date.now();
      if (remaining <= 0 || remaining > 10 * 60_000) throw new Error("Tailscale sign-in expired");
      const up = exec(cliCommand, [`--socket=${socket}`, "up", "--accept-dns=false", "--accept-routes=false", "--shields-up",
        `--timeout=${remaining}ms`, `--hostname=paperclip-${input.identity.replace(/[^a-z0-9]/gi, "").slice(-16)}`],
      { timeout: remaining + 1000, maxBuffer: MAX_STATE_BYTES });
      connection.loginChild = up.child;
      let loginFailed = false;
      const completion = up.then(async () => {
        if (connection.closed) return;
        if (Date.now() >= login.expiresAt) throw new Error("Tailscale sign-in expired");
        const status = parseTailscaleLoginStatus(JSON.parse((await cli(["status", "--json"])).stdout));
        if (status.status !== "connected") throw new Error("Tailscale sign-in did not complete");
        await save();
        if (!connection.closed) await login.onAuthorized();
      }).catch(async () => {
        loginFailed = true;
        if (connection.closed) return;
        try { await login.onFailure(); } finally { await connection.close(); }
      });
      // The active CLI watches Tailscale events until consent, cancellation, or expiry.
      void completion.catch(() => undefined);
      connection.loginStatus = async () => {
        if (loginFailed || connection.closed) throw new Error("Tailscale sign-in did not complete");
        const status = parseTailscaleLoginStatus(JSON.parse((await cli(["status", "--json"])).stdout));
        if (status.status === "connected") await completion;
        if (loginFailed || connection.closed) throw new Error("Tailscale sign-in did not complete");
        return status;
      };
      const loginDeadline = Math.min(login.expiresAt, Date.now() + 10_000);
      for (;;) {
        const status = await connection.loginStatus();
        if (status.status !== "authorizing" || status.authorizationUrl) {
          await save();
          if (failed || connection.closed) throw new Error("Tailscale stopped");
          return socket;
        }
        if (Date.now() >= loginDeadline) throw new Error("Tailscale sign-in timed out");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    if (!restored) await fs.writeFile(keyPath, input.credential, { mode: 0o600 });
    try {
      await cli(["up", "--accept-dns=false", "--accept-routes=false", "--shields-up", "--timeout=30s",
        `--hostname=paperclip-${input.identity.replace(/[^a-z0-9]/gi, "").slice(-16)}`,
        ...(!restored ? [`--auth-key=file:${keyPath}`] : [])], 35_000);
    } finally {
      await fs.rm(keyPath, { force: true });
    }
    const status = JSON.parse((await cli(["status", "--json"])).stdout);
    if (status.BackendState !== "Running") throw new Error("Tailscale requires authorization");
    connection.savedCredential = input.credential;
    await save();
    if (failed || connection.closed) throw new Error("Tailscale stopped");
    return socket;
  }

  return {
    connect: (input: Parameters<typeof connect>[0]) => connect(input),
    async loginStatus(identity: string) {
      const connection = connections.get(identity);
      if (!connection) return null;
      await connection.ready;
      return connection.loginStatus ? connection.loginStatus() : { status: "connected" as const };
    },
    async disconnect(identity: string, options: { discardState?: boolean } = {}) {
      const connection = connections.get(identity);
      if (!connection) return;
      if (options.discardState) connection.discardState.abort();
      await connection.close();
    },
    async close() {
      generation += 1;
      await Promise.all([...connections.values()].map((connection) => connection.close()));
    },
  };
}

export const tailscaleNetworks = createTailscaleNetworkManager();
