/**
 * Behavioural regression tests for AGENT_HOME isolation in the hermes adapter.
 *
 * RBR-943: for seven consecutive days every run on this host started with
 * `AGENT_HOME` pointing at a *fixed foreign agent's* home directory — the IOA's
 * — regardless of which agent the run belonged to. Agent operating instructions
 * define memory almost entirely in terms of `$AGENT_HOME`
 * (`$AGENT_HOME/MEMORY.md`, `$AGENT_HOME/life/`,
 * `$AGENT_HOME/memory/YYYY-MM-DD.md`), so any agent following its instructions
 * literally would write its memory into that other agent's directory. Two
 * distinct failures: same-day daily notes from two agents collide on one
 * `memory/YYYY-MM-DD.md`, and a read-only oversight agent's home becomes
 * writable by the party it audits.
 *
 * Root cause was twofold and both halves are asserted here:
 *   1. This adapter never read `context.paperclipWorkspace.agentHome`, so the
 *      only `AGENT_HOME` a child ever saw was the one inherited from the server
 *      process environment.
 *   2. The host's server process had a stale `export AGENT_HOME=<IOA path>` in a
 *      shell rc file, so that inherited value was a constant foreign agent id.
 *
 * These assertions are behavioural: they inspect the environment actually handed
 * to the spawned child, not the shape of a helper's return value. The core
 * invariant — "a run for agent A never receives an AGENT_HOME belonging to agent
 * B" — is asserted directly against that env.
 */

import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute, resolveAgentHomeEnv } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

const COMPANY = "5cb37f67-a875-4073-ba4f-f8f942cb0775";
const INSTANCE_ROOT = "/tmp/paperclip-test/instances/default";

/** The real ids from the RBR-943 report, so the regression reads as the incident. */
const CEO = "53c28b5d-342d-4801-bd18-9f343f7bc695";
const IOA = "168e1f8b-cf2d-41f3-94b7-124c517aac39";
const CTO = "b7079c44-d677-4640-89e7-1e2cfc49bbe0";

function homeOf(agentId: string): string {
  return `${INSTANCE_ROOT}/companies/${COMPANY}/agents/${agentId}`;
}

function makeCtx(input: {
  agentId: string;
  agentName: string;
  /** What the heartbeat resolved and published for this run. */
  resolvedAgentHome?: string | null;
}) {
  return {
    runId: `run-for-${input.agentId}`,
    agent: {
      id: input.agentId,
      companyId: COMPANY,
      name: input.agentName,
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "/usr/bin/hermes", timeoutSec: 60, graceSec: 5 },
    context: {
      issueId: "issue-1",
      wakeReason: "issue_assigned",
      paperclipWake: null,
      paperclipWorkspace:
        input.resolvedAgentHome === undefined
          ? { cwd: "/tmp/paperclip-test/ws", agentHome: homeOf(input.agentId) }
          : { cwd: "/tmp/paperclip-test/ws", agentHome: input.resolvedAgentHome },
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  } as unknown as Record<string, unknown>;
}

/** The env actually handed to the spawned child on the most recent execute(). */
function spawnedEnv(): Record<string, string> {
  const mocked = vi.mocked(serverUtils.runChildProcess);
  expect(mocked.mock.calls.length).toBeGreaterThan(0);
  const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
  return (lastCall[3] as { env: Record<string, string> }).env;
}

/**
 * The invariant, stated once: whatever AGENT_HOME the child receives, it must
 * not be inside any *other* agent's home directory.
 */
function expectAgentHomeNotForeign(env: Record<string, string>, ownAgentId: string, others: string[]) {
  const agentHome = env.AGENT_HOME;
  for (const other of others) {
    if (other === ownAgentId) continue;
    expect(agentHome ?? "").not.toContain(other);
  }
}

describe("hermes adapter AGENT_HOME isolation (RBR-943)", () => {
  const savedAgentHome = process.env.AGENT_HOME;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_HOME;
  });

  afterEach(() => {
    if (savedAgentHome === undefined) delete process.env.AGENT_HOME;
    else process.env.AGENT_HOME = savedAgentHome;
  });

  it("gives each agent its own AGENT_HOME, not a shared or foreign one", async () => {
    const seen: Record<string, string | undefined> = {};
    for (const [agentId, name] of [
      [CEO, "CEO"],
      [IOA, "IOA"],
      [CTO, "CTO"],
    ] as const) {
      vi.clearAllMocks();
      await execute(makeCtx({ agentId, agentName: name }) as never);
      const env = spawnedEnv();
      seen[name] = env.AGENT_HOME;
      // Positive: it is this agent's own home.
      expect(env.AGENT_HOME).toBe(homeOf(agentId));
      // Negative: it is nobody else's home.
      expectAgentHomeNotForeign(env, agentId, [CEO, IOA, CTO]);
    }
    // And all three are distinct — the original bug handed every agent the
    // same path, which this assertion alone would have caught.
    const distinct = new Set(Object.values(seen));
    expect(distinct.size).toBe(3);
  });

  it("a CEO run never receives the IOA's AGENT_HOME even when the server process env leaks it", async () => {
    // Reproduce the exact host condition: a stale `export AGENT_HOME=<IOA>` in a
    // shell rc file, inherited by the Paperclip server and thus by every child.
    process.env.AGENT_HOME = homeOf(IOA);

    await execute(makeCtx({ agentId: CEO, agentName: "CEO" }) as never);

    const env = spawnedEnv();
    expect(env.AGENT_HOME).toBe(homeOf(CEO));
    expect(env.AGENT_HOME).not.toBe(homeOf(IOA));
    expect(env.AGENT_HOME).not.toContain(IOA);
  });

  it("is not CEO-specific: a non-CEO, non-IOA agent is protected from the same leak", async () => {
    // A general bug means other agents' memories are also cross-writing, so the
    // fix must hold for an ordinary agent too, not just the reported pair.
    process.env.AGENT_HOME = homeOf(IOA);

    await execute(makeCtx({ agentId: CTO, agentName: "CTO" }) as never);

    const env = spawnedEnv();
    expect(env.AGENT_HOME).toBe(homeOf(CTO));
    expect(env.AGENT_HOME).not.toContain(IOA);
    expect(env.AGENT_HOME).not.toContain(CEO);
  });

  it("drops an unattributable inherited AGENT_HOME rather than passing a foreign one through", async () => {
    // When the run resolves no home, a leaked foreign value must NOT survive:
    // absent is a loud, recoverable failure; confidently wrong silently
    // corrupts another agent's memory.
    process.env.AGENT_HOME = homeOf(IOA);

    await execute(makeCtx({ agentId: CEO, agentName: "CEO", resolvedAgentHome: null }) as never);

    const env = spawnedEnv();
    expect(env.AGENT_HOME).toBeUndefined();
  });

  it("keeps an inherited AGENT_HOME that is demonstrably the run's own agent home", async () => {
    process.env.AGENT_HOME = homeOf(CEO);

    await execute(makeCtx({ agentId: CEO, agentName: "CEO", resolvedAgentHome: null }) as never);

    expect(spawnedEnv().AGENT_HOME).toBe(homeOf(CEO));
  });

  it("warns operators when it overrides a mismatched inherited AGENT_HOME", async () => {
    process.env.AGENT_HOME = homeOf(IOA);
    const ctx = makeCtx({ agentId: CEO, agentName: "CEO" });

    await execute(ctx as never);

    const onLog = vi.mocked(ctx.onLog as (channel: string, line: string) => Promise<void>);
    const logged = onLog.mock.calls.map((call) => String(call[1])).join("\n");
    expect(logged).toContain("AGENT_HOME");
    expect(logged).toContain(IOA);
  });
});

describe("resolveAgentHomeEnv", () => {
  it("prefers the run-resolved home over a mismatched inherited value", () => {
    const result = resolveAgentHomeEnv({
      inherited: homeOf(IOA),
      resolvedAgentHome: homeOf(CEO),
      agentId: CEO,
    });
    expect(result.agentHome).toBe(homeOf(CEO));
    expect(result.warning).toContain(IOA);
  });

  it("does not warn when the inherited value already agrees", () => {
    const result = resolveAgentHomeEnv({
      inherited: homeOf(CEO),
      resolvedAgentHome: homeOf(CEO),
      agentId: CEO,
    });
    expect(result.agentHome).toBe(homeOf(CEO));
    expect(result.warning).toBeNull();
  });

  it("drops a foreign inherited value when nothing was resolved", () => {
    const result = resolveAgentHomeEnv({
      inherited: homeOf(IOA),
      resolvedAgentHome: null,
      agentId: CEO,
    });
    expect(result.agentHome).toBeNull();
    expect(result.warning).toContain("does not belong to agent");
  });

  it("accepts an inherited value whose final segment is the agent's own id", () => {
    const result = resolveAgentHomeEnv({
      inherited: `${homeOf(CEO)}/`,
      resolvedAgentHome: null,
      agentId: CEO,
    });
    expect(result.agentHome).toBe(`${homeOf(CEO)}/`);
    expect(result.warning).toBeNull();
  });

  it("returns nothing when there is neither an inherited nor a resolved home", () => {
    const result = resolveAgentHomeEnv({ inherited: "", resolvedAgentHome: "", agentId: CEO });
    expect(result.agentHome).toBeNull();
    expect(result.warning).toBeNull();
  });
});
