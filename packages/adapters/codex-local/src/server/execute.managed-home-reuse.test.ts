import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "./execute.js";
import { sessionCodec } from "./index.js";

// A managed AI connection materializes its credential into a fresh mkdtemp
// directory for every run and removes it when the run ends. These tests drive
// the real `execute()` with a fake `codex` binary to prove that unchanged runs
// share one generated runtime home, that real changes still separate homes,
// and that overlapping runs never break each other's credential link.

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.CODEX_HOME;
const readAuth = () => { try { return fs.readFileSync(path.join(home, "auth.json"), "utf8"); } catch (e) { return "ERR:" + e.code; } };
const startAuth = readAuth();
const finish = () => {
  fs.writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({ codexHome: home, startAuth, endAuth: readAuth(), argv: process.argv.slice(2) }));
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
  process.exit(Number(process.env.TEST_EXIT_CODE || "0"));
};
fs.readFileSync(0);
const gate = process.env.TEST_GATE;
if (process.env.TEST_STARTED) fs.writeFileSync(process.env.TEST_STARTED, "1");
if (gate) {
  const wait = () => fs.existsSync(gate) ? finish() : setTimeout(wait, 20);
  wait();
} else if (process.env.TEST_SLEEP_MS) setTimeout(finish, Number(process.env.TEST_SLEEP_MS));
else finish();
`;

type Capture = { codexHome: string; startAuth: string; endAuth: string; argv: string[] };

const ENV_KEYS = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "CODEX_HOME"] as const;
let root: string;
let previousEnv: Record<string, string | undefined>;
let counter = 0;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-reuse-"));
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.PAPERCLIP_HOME = path.join(root, "paperclip");
  process.env.PAPERCLIP_INSTANCE_ID = "reuse";
  // The host's shared login must never be consulted for a managed connection.
  process.env.CODEX_HOME = path.join(root, "host-codex-home");
  await fs.mkdir(path.join(root, "workspace"), { recursive: true });
  await fs.mkdir(path.join(root, "skill-v1"), { recursive: true });
  await fs.writeFile(path.join(root, "skill-v1", "SKILL.md"), "# Skill\nversion one");
  await fs.mkdir(path.join(root, "skill-v2"), { recursive: true });
  await fs.writeFile(path.join(root, "skill-v2", "SKILL.md"), "# Skill\nversion two");
  await fs.writeFile(path.join(root, "codex"), FAKE_CODEX, { mode: 0o755 });
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  await fs.rm(root, { recursive: true, force: true });
});

function auth(accountId: string, token = "access-token") {
  return JSON.stringify({ tokens: { account_id: accountId, access_token: token } });
}

interface RunOptions {
  agentId?: string;
  accountId?: string;
  token?: string;
  sessionIdentity?: string;
  skillSource?: string | null;
  extraConfigToml?: string;
  exitCode?: number;
  sleepMs?: number;
  gate?: string;
  started?: string;
  timeoutSec?: number;
  sessionParams?: Record<string, unknown> | null;
  context?: Record<string, unknown>;
}

/** Materialize a per-run connection home (as the server does), run, then remove it. */
async function run(options: RunOptions = {}) {
  // Number the run before any await: overlapping runs must not share a capture file.
  const runNumber = ++counter;
  const tempHome = await fs.mkdtemp(path.join(root, "paperclip-ai-company-1-grant-1-"));
  const providerHome = path.join(tempHome, "provider");
  await fs.mkdir(providerHome, { mode: 0o700 });
  await fs.writeFile(path.join(providerHome, "auth.json"), auth(options.accountId ?? "account-1", options.token), { mode: 0o600 });
  await fs.writeFile(path.join(providerHome, "config.toml"),
    `cli_auth_credentials_store = "file"\n${options.extraConfigToml ?? ""}`, { mode: 0o600 });
  const capture = path.join(root, `capture-${runNumber}.json`);
  const skillSource = options.skillSource === undefined ? path.join(root, "skill-v1") : options.skillSource;
  const config = {
    engine: "cli",
    command: path.join(root, "codex"),
    cwd: path.join(root, "workspace"),
    timeoutSec: options.timeoutSec ?? 0,
    graceSec: 1,
    env: {
      HOME: tempHome,
      CODEX_HOME: providerHome,
      OPENAI_API_KEY: "",
      TEST_CAPTURE: capture,
      ...(options.exitCode !== undefined ? { TEST_EXIT_CODE: String(options.exitCode) } : {}),
      ...(options.sleepMs !== undefined ? { TEST_SLEEP_MS: String(options.sleepMs) } : {}),
      ...(options.gate ? { TEST_GATE: options.gate } : {}),
      ...(options.started ? { TEST_STARTED: options.started } : {}),
    },
    managedAiConnection: {
      method: "subscription",
      provider: "openai",
      identity: `grant-1:user-1:${options.token ?? "generation"}`,
      sessionIdentity: options.sessionIdentity ?? "grant-1:user-1:secret-1:1",
    },
    paperclipSkillSync: { desiredSkills: skillSource ? ["paperclipai/paperclip/fixture"] : [] },
    paperclipRuntimeSkills: skillSource
      ? [{ key: "paperclipai/paperclip/fixture", runtimeName: "fixture", source: skillSource }]
      : [],
  };
  const agentId = options.agentId ?? "agent-1";
  try {
    const result = await execute({
      runId: `run-${runNumber}`,
      agent: { id: agentId, companyId: "company-1", name: "Agent", adapterType: "codex_local", adapterConfig: config },
      runtime: {
        sessionId: null,
        sessionParams: options.sessionParams ?? null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config,
      context: options.context ?? {},
      authToken: "run-token",
      onLog: async () => {},
    });
    const captured = await fs.readFile(capture, "utf8").then((raw) => JSON.parse(raw) as Capture).catch(() => null);
    return { result, capture: captured, providerHome };
  } finally {
    // The server removes the connection home when the run ends.
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

async function generatedHomes(agentId = "agent-1"): Promise<string[]> {
  const dir = path.join(root, "paperclip", "instances", "reuse", "companies", "company-1", "codex-home", "skill-runtimes", agentId);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function waitForFile(file: string) {
  for (let i = 0; i < 500; i += 1) {
    if (await fs.stat(file).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
}

describe("codex execute — managed AI connection runtime home reuse", () => {
  it("reuses one generated home across unchanged runs with a fresh per-run credential directory", async () => {
    const homes = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const { result, capture } = await run();
      expect(result.errorMessage).toBeNull();
      expect(result.exitCode).toBe(0);
      homes.add(capture!.codexHome);
    }
    expect(homes.size).toBe(1);
    expect(await generatedHomes()).toHaveLength(1);
  });

  it("gives the reused home a valid auth.json for the current run, not a dangling earlier link", async () => {
    const first = await run({ token: "token-run-1" });
    expect(first.capture!.startAuth).toBe(auth("account-1", "token-run-1"));
    // The first run's credential directory is gone now; its link would dangle.
    const second = await run({ token: "token-run-2" });
    expect(second.capture!.codexHome).toBe(first.capture!.codexHome);
    expect(second.capture!.startAuth).toBe(auth("account-1", "token-run-2"));
    // A regular-file credential left in the home (for example by a remote
    // copy-back) must not override the connection's current credential.
    const authPath = path.join(first.capture!.codexHome, "auth.json");
    await fs.rm(authPath, { force: true });
    await fs.writeFile(authPath, auth("account-1", "stale-left-in-home"));
    const third = await run({ token: "token-run-3" });
    expect(third.capture!.codexHome).toBe(first.capture!.codexHome);
    expect(third.capture!.startAuth).toBe(auth("account-1", "token-run-3"));
  });

  it("selects a different home for a changed skill inventory, revocation, account, connection or config", async () => {
    const base = (await run()).capture!.codexHome;
    const changed = [
      (await run({ skillSource: path.join(root, "skill-v2") })).capture!.codexHome,
      (await run({ skillSource: null })).capture!.codexHome,
      (await run({ accountId: "account-2" })).capture!.codexHome,
      (await run({ sessionIdentity: "grant-2:user-1:secret-2:1" })).capture!.codexHome,
      (await run({ extraConfigToml: '[mcp_servers.extra]\ncommand = "extra-server"\n' })).capture!.codexHome,
      (await run({ agentId: "agent-2" })).capture!.codexHome,
    ];
    expect(new Set([base, ...changed]).size).toBe(changed.length + 1);
    // A token refresh for the same account keeps the home (and its sessions).
    expect((await run({ token: "refreshed" })).capture!.codexHome).toBe(base);
    // Revocation must not fall back to the populated home's skills.
    const revoked = (await run({ skillSource: null })).capture!.codexHome;
    await expect(fs.stat(path.join(revoked, "skills", "fixture"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps overlapping runs of one agent on separate homes so neither credential link breaks", async () => {
    const gateA = path.join(root, "gate-a");
    const startedA = path.join(root, "started-a");
    const runA = run({ token: "token-a", gate: gateA, started: startedA });
    await waitForFile(startedA);
    // B starts and finishes (removing its credential directory) while A runs.
    const runB = await run({ token: "token-b" });
    expect(runB.result.errorMessage).toBeNull();
    await fs.writeFile(gateA, "go");
    const a = await runA;
    expect(a.result.errorMessage).toBeNull();
    expect(a.result.exitCode).toBe(0);
    expect(a.capture!.startAuth).toBe(auth("account-1", "token-a"));
    expect(a.capture!.endAuth).toBe(auth("account-1", "token-a"));
    expect(runB.capture!.startAuth).toBe(auth("account-1", "token-b"));
    expect(runB.capture!.codexHome).not.toBe(a.capture!.codexHome);
    // Once both have finished, the next run returns to the primary home.
    const next = await run();
    expect([a.capture!.codexHome, runB.capture!.codexHome]).toContain(next.capture!.codexHome);
    expect(await generatedHomes()).toHaveLength(2);
  });

  it("resumes a conversation in the secondary home that holds it", async () => {
    const gateA = path.join(root, "gate-a");
    const startedA = path.join(root, "started-a");
    const runA = run({ gate: gateA, started: startedA });
    await waitForFile(startedA);
    const b = await run();
    await fs.writeFile(gateA, "go");
    const a = await runA;
    expect(b.capture!.codexHome).not.toBe(a.capture!.codexHome);
    // The saved session names the home its conversation lives in, and survives
    // the session codec the server stores it through.
    const saved = sessionCodec.deserialize(sessionCodec.serialize(b.result.sessionParams ?? null));
    expect(saved).toMatchObject({ sessionId: "thread-1", codexRuntimeHome: path.basename(b.capture!.codexHome) });
    // Both homes are free now; continuing B's conversation must return to B's home.
    const resumed = await run({ sessionParams: saved });
    expect(resumed.result.errorMessage).toBeNull();
    expect(resumed.capture!.codexHome).toBe(b.capture!.codexHome);
    expect(resumed.capture!.argv).toContain("thread-1");
    // A fresh conversation still starts in the primary home.
    expect((await run()).capture!.codexHome).toBe(a.capture!.codexHome);
  });

  it("never follows links or shared files an agent left in the reused home", async () => {
    const home = (await run()).capture!.codexHome;
    const outside = path.join(root, "outside");
    await fs.mkdir(path.join(outside, "skills"), { recursive: true });
    for (const name of ["config.toml", "config.json", "instructions.md"]) {
      await fs.writeFile(path.join(outside, name), "host-owned");
      await fs.rm(path.join(home, name), { force: true });
      await fs.symlink(path.join(outside, name), path.join(home, name));
    }
    await fs.rm(path.join(home, "skills"), { recursive: true, force: true });
    await fs.symlink(path.join(outside, "skills"), path.join(home, "skills"));
    const context = {
      paperclipManagedMcp: {
        managedMcpOnly: true,
        gateways: [{ name: "gateway", endpointPath: "/mcp/gateway", bearerToken: "bearer-for-this-run" }],
      },
    };
    const second = await run({ context });
    expect(second.result.errorMessage).toBeNull();
    expect(second.capture!.codexHome).toBe(home);
    for (const name of ["config.toml", "config.json", "instructions.md"]) {
      expect(await fs.readFile(path.join(outside, name), "utf8")).toBe("host-owned");
      expect((await fs.lstat(path.join(home, name)).catch(() => null))?.isSymbolicLink() ?? false).toBe(false);
    }
    expect(await fs.readdir(path.join(outside, "skills"))).toEqual([]);
    expect((await fs.lstat(path.join(home, "skills"))).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toContain("bearer-for-this-run");

    // A hard link to a host file is not followed either.
    await fs.rm(path.join(home, "config.toml"));
    await fs.link(path.join(outside, "config.toml"), path.join(home, "config.toml"));
    expect((await run({ context })).capture!.codexHome).toBe(home);
    expect(await fs.readFile(path.join(outside, "config.toml"), "utf8")).toBe("host-owned");
    expect((await fs.stat(path.join(home, "config.toml"))).nlink).toBe(1);
  });

  it("runs many overlapping runs of one agent without failures and reuses their homes afterwards", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => run({ token: `token-${i}`, sleepMs: 200 })));
    for (const [i, { result, capture }] of results.entries()) {
      expect(result.errorMessage).toBeNull();
      expect(capture!.startAuth).toBe(auth("account-1", `token-${i}`));
      expect(capture!.endAuth).toBe(auth("account-1", `token-${i}`));
    }
    expect(new Set(results.map((entry) => entry.capture!.codexHome)).size).toBe(4);
    await Promise.all(Array.from({ length: 4 }, () => run({ sleepMs: 50 })));
    expect(await generatedHomes()).toHaveLength(4);
  });

  it.each([
    ["a failed run", { exitCode: 1 }],
    ["a timed-out run", { sleepMs: 30_000, timeoutSec: 1 }],
  ] as const)("releases the home after %s so the next run reuses it", async (_label, options) => {
    const failed = await run(options);
    expect(failed.result.exitCode === 0 && !failed.result.timedOut).toBe(false);
    const next = await run();
    expect(next.capture!.codexHome).toBe(failed.capture?.codexHome ?? next.capture!.codexHome);
    expect(await generatedHomes()).toHaveLength(1);
  }, 20_000);

  it("releases the home when setup throws before the launch", async () => {
    // No credential at all: the launch guard rejects the run before Codex starts.
    const tempHome = await fs.mkdtemp(path.join(root, "paperclip-ai-company-1-grant-1-"));
    const providerHome = path.join(tempHome, "provider");
    await fs.mkdir(providerHome);
    await fs.writeFile(path.join(providerHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
    const config = {
      engine: "cli", command: path.join(root, "codex"), cwd: path.join(root, "workspace"),
      env: { CODEX_HOME: providerHome, OPENAI_API_KEY: "", TEST_CAPTURE: path.join(root, "unused.json") },
      managedAiConnection: { method: "subscription", provider: "openai", identity: "x", sessionIdentity: "grant-1:user-1:secret-1:1" },
      paperclipSkillSync: { desiredSkills: [] }, paperclipRuntimeSkills: [],
    };
    const invoke = () => execute({
      runId: `run-throw-${++counter}`,
      agent: { id: "agent-throw", companyId: "company-1", name: "Agent", adapterType: "codex_local", adapterConfig: config },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config, context: {}, authToken: "run-token", onLog: async () => {},
    }).then((result) => result, (error: unknown) => error);
    await invoke();
    await invoke();
    await invoke();
    expect(await generatedHomes("agent-throw")).toHaveLength(1);
    await fs.rm(tempHome, { recursive: true, force: true });
  });
});
