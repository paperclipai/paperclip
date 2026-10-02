// Tests for the sandbox run site (Phase 19).
//
// The sandbox site owns staging, the staging lease, both bridges, the launch-
// environment contribution, and sync-back. These tests drive the site in
// isolation with fakes: they pin the ledger registrations, the bridge overlap and
// the callback-environment sequencing point, the staged-files reuse (which still
// creates the runtime), the synchronous plan, and Amendment B — no run-scoped
// contribution or bridge token escapes into the ledger or the reuse payload.

import { describe, expect, it } from "vitest";
import {
  createSandboxRunSite,
  type ManagedHomeSeamResult,
  type SandboxRunSiteOptions,
  type StagedRuntimeStoreEntry,
} from "./run-site-sandbox.js";
import type {
  AcpRunContext,
  AcquiredRunResources,
  LaunchEnvironmentContribution,
  ReadyRunResources,
  ResourceId,
  RunResourceRegistration,
  SandboxReuseCandidate,
  StagedRuntimeResource,
} from "./run-contracts.js";
import type { PreparedAdapterExecutionTargetRuntime } from "@paperclipai/adapter-utils/execution-target";

function makeStagedRuntime(id: string): PreparedAdapterExecutionTargetRuntime {
  return {
    runtimeRootDir: `/remote/${id}/.paperclip-runtime/acpx`,
    additionalSourceDirs: {},
    additionalSourceFailures: [],
  } as unknown as PreparedAdapterExecutionTargetRuntime;
}

function makeLedger(): { ledger: AcquiredRunResources; registered: RunResourceRegistration[] } {
  const registered: RunResourceRegistration[] = [];
  const ledger: AcquiredRunResources = {
    register(registration) {
      registered.push(registration as RunResourceRegistration);
    },
    seal() {
      throw new Error("seal is not exercised by these unit tests");
    },
    takeForSettlement() {
      throw new Error("takeForSettlement is not exercised by these unit tests");
    },
  };
  return { ledger, registered };
}

function makeContext(sessionKey: string): AcpRunContext {
  return { sessionKey } as unknown as AcpRunContext;
}

/** Build a site over injectable fakes. Every option has a sensible default. */
function makeSite(overrides: Partial<SandboxRunSiteOptions> = {}) {
  const { ledger, registered } = makeLedger();
  const env: Record<string, string> = { BASE: "1" };
  const stagedRuntimes = new Map<string, StagedRuntimeStoreEntry>();
  const stagingLocks = new Map<string, Promise<unknown>>();
  const freshStaged = makeStagedRuntime("fresh");
  const bridgeCalls: string[] = [];
  const options: SandboxRunSiteOptions = {
    ledger,
    stagedRuntimes,
    stagingLocks,
    now: () => 1000,
    idleMs: 60_000,
    sessionCwd: "/remote/workspace",
    spawnCwd: "/host/workspace",
    target: { kind: "remote" } as unknown as SandboxRunSiteOptions["target"],
    env,
    isCompatibleResume: false,
    stage: async () => freshStaged,
    seedManagedHome: async (stage) => {
      const stagedRuntime = await stage([]);
      // Repoint a managed-home env var, so the site captures the delta.
      env.CODEX_HOME = "/remote/home";
      return {
        stagedRuntime,
        teardown: async () => ({ ok: true }),
        dispose: async () => {},
      } satisfies ManagedHomeSeamResult;
    },
    disposeFreshStagedRuntime: async () => {},
    measureStageStep: (run) => run(),
    publishStagedProjectHints: () => {},
    onReuseLog: async () => {},
    startPaperclipBridge: async () => {
      bridgeCalls.push("paperclip:start");
      return { env: { PAPERCLIP_API_KEY: "run-token" }, stop: async () => {} } as never;
    },
    startProcessSessionBridge: async ({ launchEnv }) => {
      bridgeCalls.push("process-session:start");
      await launchEnv();
      return { agentCommand: null, stop: async () => {} } as never;
    },
    measureBridgeStep: (_step, run) => run(),
    finalizeLaunchEnv: (contributions) => {
      const merged = { ...env };
      for (const contribution of contributions) Object.assign(merged, contribution.env);
      return merged;
    },
    onPaperclipBridgeLog: async () => {},
    stopBridges: async () => {},
    ...overrides,
  };
  const site = createSandboxRunSite(options);
  return { site, ledger, registered, env, stagedRuntimes, stagingLocks, freshStaged, bridgeCalls, options };
}

/** A minimal `ReadyRunResources` that resolves a single staged runtime. */
function makeReady(stagedRuntime: PreparedAdapterExecutionTargetRuntime): ReadyRunResources {
  const staged: StagedRuntimeResource = { stagedRuntime, disposeStaged: async () => {} };
  return {
    get: (id: ResourceId) => (id === "staged_runtime" ? staged : undefined),
    scopeOf: () => undefined,
    has: (id: ResourceId) => id === "staged_runtime",
    sealed: ["staged_runtime"],
  } as unknown as ReadyRunResources;
}

describe("sandbox run site", () => {
  it("test_sandbox_site_registers_staging_bridges_and_lease_in_ledger", async () => {
    const { site, registered } = makeSite();
    await site.placeWorkspace(makeContext("paperclip:c:a:t:fp"));
    await site.startTransport(makeContext("paperclip:c:a:t:fp"));

    const byId = new Set(registered.map((entry) => entry.id));
    // Staging registers the staged runtime, the managed-home copy-back, and the
    // per-session staging lease. Both bridge starts register their handles.
    expect(byId).toEqual(
      new Set<ResourceId>(["staged_runtime", "managed_home", "staging_lease", "control_bridge", "agent_bridge"]),
    );
    // The staged runtime is startup-rollback until a clean turn promotes it; the
    // copy-back, the lease, and the bridges live through the whole run.
    const scopeOf = (id: ResourceId) => registered.find((entry) => entry.id === id)?.scope;
    expect(scopeOf("staged_runtime")).toBe("startup_rollback");
    expect(scopeOf("managed_home")).toBe("per_run");
    expect(scopeOf("staging_lease")).toBe("per_run");
    expect(scopeOf("control_bridge")).toBe("per_run");
    expect(scopeOf("agent_bridge")).toBe("per_run");
  });

  it("test_sandbox_site_place_workspace_carries_referenced_project_failure_reason", async () => {
    // A referenced project that fails to stage carries its failure reason back on
    // the placed-workspace result, so a reader of the run learns why it dropped.
    const failedStaged = {
      runtimeRootDir: "/remote/fail/.paperclip-runtime/acpx",
      additionalSourceDirs: {},
      additionalSourceFailures: [{ projectId: "proj-x", error: "extract failed: boom" }],
    } as unknown as PreparedAdapterExecutionTargetRuntime;
    const { site } = makeSite({ stage: async () => failedStaged });

    const placed = await site.placeWorkspace(makeContext("s"));

    expect(placed).toEqual({
      referencedProjectStagingFailures: [{ projectId: "proj-x", error: "extract failed: boom" }],
    });
  });

  it("test_sandbox_site_preserves_bridge_overlap_and_callback_sequencing", async () => {
    const events: string[] = [];
    let releasePaperclip!: () => void;
    const paperclipGate = new Promise<void>((resolve) => {
      releasePaperclip = resolve;
    });
    let processLaunchEnv: Record<string, string> | null = null;
    const { site } = makeSite({
      startPaperclipBridge: async () => {
        events.push("paperclip:start");
        await paperclipGate;
        events.push("paperclip:env-ready");
        return { env: { PAPERCLIP_API_KEY: "run-token" }, stop: async () => {} } as never;
      },
      startProcessSessionBridge: async ({ launchEnv }) => {
        events.push("process-session:start");
        // The launch awaits the sequencing point, so it observes the merged env.
        processLaunchEnv = await launchEnv();
        events.push("process-session:launch");
        return { agentCommand: null, stop: async () => {} } as never;
      },
    });

    await site.placeWorkspace(makeContext("s"));
    const transportPromise = site.startTransport(makeContext("s"));
    // Both bridges start before the paperclip env resolves: their setup overlaps.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toContain("paperclip:start");
    expect(events).toContain("process-session:start");
    expect(events).not.toContain("process-session:launch");

    // Release the paperclip env; the process-session launch now observes the
    // merged run-scoped env (the single sequencing point).
    releasePaperclip();
    const transport = await transportPromise;
    expect(events.indexOf("paperclip:env-ready")).toBeLessThan(events.indexOf("process-session:launch"));
    expect(processLaunchEnv).toEqual({ BASE: "1", CODEX_HOME: "/remote/home", PAPERCLIP_API_KEY: "run-token" });
    expect(transport.launchEnv).toEqual(processLaunchEnv);
  });

  it("test_sandbox_site_session_new_starts_only_after_the_sync_barrier_settles", async () => {
    // The staging step wraps the inbound sync coordinator. Hold it open with a
    // gate, so the sync barrier stays unsettled. `placeWorkspace` awaits staging,
    // so it stays pending while the gate is held.
    let releaseStaging!: () => void;
    const stagingGate = new Promise<void>((resolve) => {
      releaseStaging = resolve;
    });
    const freshStaged = makeStagedRuntime("fresh");
    const { site, bridgeCalls } = makeSite({
      stage: async () => {
        await stagingGate;
        return freshStaged;
      },
    });

    // Drive the real run order: the engine awaits `placeWorkspace`, then starts the
    // transport. `startProcessSessionBridge` models the ACP `session/new` startup.
    let placed = false;
    const run = (async () => {
      await site.placeWorkspace(makeContext("s"));
      placed = true;
      await site.startTransport(makeContext("s"));
    })();
    run.catch(() => undefined);

    // The sync barrier is still open, so `placeWorkspace` has not resolved and the
    // process-session bridge that starts `session/new` has not started.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(placed).toBe(false);
    expect(bridgeCalls).not.toContain("process-session:start");

    // Settle the sync barrier. `placeWorkspace` resolves, then the transport starts
    // `session/new`.
    releaseStaging();
    await run;
    expect(placed).toBe(true);
    expect(bridgeCalls).toContain("process-session:start");
  });

  it("test_sandbox_site_borrow_yields_files_and_runtime_is_still_created", async () => {
    const cachedRuntime = makeStagedRuntime("cached");
    const stagedRuntimes = new Map<string, StagedRuntimeStoreEntry>([
      [
        "paperclip:c:a:t:fp",
        {
          stagedRuntime: cachedRuntime,
          envDelta: { CODEX_HOME: "/remote/home" },
          teardown: async () => ({ ok: true }),
          dispose: async () => {},
          lastUsedAt: 500,
        },
      ],
    ]);
    const { site, env } = makeSite({ stagedRuntimes, isCompatibleResume: true });

    // A borrow reads the staged entry without removal, so an overlapping run of
    // the same session still reads it.
    const borrowed = site.reuse().borrow("paperclip:c:a:t:fp");
    expect(borrowed?.stagedRuntime).toBe(cachedRuntime);
    expect(stagedRuntimes.has("paperclip:c:a:t:fp")).toBe(true);

    // A reuse hit yields the staged FILES (not a live runtime): `placeWorkspace`
    // reports `reused` and re-applies the seam env delta, and the reuse candidate
    // names the staged files only. So the run still creates the runtime and runs
    // the handshake against the reused files.
    await site.placeWorkspace(makeContext("paperclip:c:a:t:fp"));
    expect(site.staged?.reused).toBe(true);
    expect(site.staged?.stagedRuntime).toBe(cachedRuntime);
    expect(env.CODEX_HOME).toBe("/remote/home");
    const candidate: SandboxReuseCandidate = site.reuseCandidate(makeReady(cachedRuntime));
    expect(candidate).toEqual({ stagedRuntime: cachedRuntime });
    expect("runtime" in candidate).toBe(false);
    expect("sessionHandle" in candidate).toBe(false);
  });

  it("test_site_plan_supplies_session_cwd_spawn_cwd_and_tracing_before_the_fingerprint_build", () => {
    const { site } = makeSite();
    // `plan()` is synchronous and reads no staged state, so it runs before the
    // fingerprint build. It binds the session to the in-sandbox cwd, redirects the
    // relay-proxy spawn to the host cwd, and enables sandbox tracing.
    expect(site.plan(makeContext("s"))).toEqual({
      sessionCwd: "/remote/workspace",
      spawnCwd: "/host/workspace",
      tracingEnabled: true,
    });
  });

  it("test_bridge_contribution_is_not_retained_by_site_ledger_or_reuse_payload", async () => {
    const { site, registered } = makeSite();
    await site.placeWorkspace(makeContext("s"));
    const transport = await site.startTransport(makeContext("s"));

    // The ledger holds the bridge HANDLES, never the run-scoped token env.
    const control = registered.find((entry) => entry.id === "control_bridge");
    expect(control?.payload).toBe(transport.controlBridge);
    // The staged reuse payload carries the staged files only — no credential
    // material and no bridge token.
    const candidate = site.reuseCandidate(makeReady(site.staged!.stagedRuntime));
    expect(Object.keys(candidate)).toEqual(["stagedRuntime"]);

    // Compile-time (Amendment B): a run-scoped contribution is not assignable to
    // the staged reuse payload. This function never runs; the assertion holds at
    // typecheck only. A runtime call on a synthetic value would crash.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    function _staged_reuse_payload_rejects_a_run_scoped_contribution(
      contribution: LaunchEnvironmentContribution,
    ): void {
      // @ts-expect-error a launch-environment contribution is not a staged reuse payload
      const payload: SandboxReuseCandidate = contribution;
      void payload;
    }
  });
});
