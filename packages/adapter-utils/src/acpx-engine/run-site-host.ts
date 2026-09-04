// The host run site.
//
// The host site is the literal null path: it runs the agent on the host, with
// no sandbox, no staging, and no bridges. Its store keeps a live ACP runtime and
// session handle warm across runs of the same session, so a compatible resume
// reuses the running agent instead of a fresh spawn. This is today's warm-handle
// cache, factored behind the generic reuse store.
//
// The site owns the warm store only. The engine still drives the run body; the
// site's `plan`, `placeWorkspace`, `startTransport`, and `syncBack` are the null
// operations the host lane always did (host cwd, no staging failures, no
// transport, no sync-back). A later phase routes the whole lane through the site.

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { AcpRuntime, AcpRuntimeHandle } from "acpx/runtime";
import type {
  AcpRunContext,
  HostReuseCandidate,
  PlacedWorkspace,
  ReadyRunResources,
  RunSiteTransport,
  SessionReuseStore,
  SitePlan,
} from "./run-contracts.js";
import { createSessionReuseStore } from "./session-reuse-store.js";

/** The agent child's identity, as the runtime reports it on each spawn. */
export type AcpxAgentProcessIdentity = { pid: number; startedAt: string };

/**
 * The mutable spawn-callback target and the last spawn identity a warm runtime
 * carries across runs. A warm handle can outlive the run that created it, so the
 * `current` callback stays mutable: a later heartbeat repoints it to its own
 * `onSpawn`, and `latest` lets that heartbeat re-announce the running agent.
 */
export type AcpxProcessIdentitySink = {
  current: AdapterExecutionContext["onSpawn"];
  latest: AcpxAgentProcessIdentity | null;
};

/** The live-line buffer and log path a warm runtime's child stderr carries. */
export interface ChildStderrState {
  logPath: string | null;
  pendingLiveLine: string;
}

/**
 * One warm host runtime the store keeps for the next compatible resume. It is
 * the value the host warm-handle map holds. The entry carries its own last-used
 * time and its own optional idle timer, which the store reads and writes.
 */
export interface RuntimeCacheEntry {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  childStderrState: ChildStderrState;
  processIdentitySink: AcpxProcessIdentitySink;
  fingerprint: string;
  lastUsedAt: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

/** Construction options for the host site. */
export interface HostRunSiteOptions {
  /**
   * The warm-handle map the store operates over. The engine owns it and reuses
   * it across runs, so a saved runtime stays warm for the next resume.
   */
  readonly warmHandles: Map<string, RuntimeCacheEntry>;
  readonly now: () => number;
  /** The warm-idle bound, in milliseconds. `0` or less disables the store. */
  readonly idleMs: number;
  /**
   * Close a warm runtime and flush its child stderr. The store fires it when the
   * per-entry timer expires, when the run-start sweep evicts an idle entry, and
   * on an explicit discard. The engine injects it, because the close reason and
   * the stderr flush live in the engine module.
   */
  readonly closeWarmEntry: (entry: RuntimeCacheEntry) => Promise<void>;
}

/**
 * The host run site. Its store keeps warm runtimes; every other operation is the
 * null path the host lane always ran.
 */
export interface HostRunSite {
  readonly kind: "host";
  plan(context: AcpRunContext): SitePlan;
  placeWorkspace(context: AcpRunContext): Promise<PlacedWorkspace>;
  startTransport(context: AcpRunContext): Promise<RunSiteTransport>;
  reuse(): SessionReuseStore<RuntimeCacheEntry>;
  reuseCandidate(resources: ReadyRunResources): HostReuseCandidate;
  syncBack(context: AcpRunContext): Promise<void>;
}

/** Create the host run site over the engine's warm-handle map. */
export function createHostRunSite(options: HostRunSiteOptions): HostRunSite {
  const store = createSessionReuseStore<RuntimeCacheEntry>({
    entries: options.warmHandles,
    now: options.now,
    idleMs: options.idleMs,
    lastUsedAt: (entry) => entry.lastUsedAt,
    getTimer: (entry) => entry.cleanupTimer,
    setTimer: (entry, timer) => {
      entry.cleanupTimer = timer;
    },
    // The host lane arms a per-entry idle timer on every warm save, so an idle
    // runtime closes on its own without a later run.
    perEntryTimer: true,
    release: (entry) => options.closeWarmEntry(entry),
  });

  return {
    kind: "host",
    plan(context: AcpRunContext): SitePlan {
      // The host binds the session to the run cwd. There is no relay-proxy spawn
      // cwd off the host, and the host emits no sandbox trace spans.
      return {
        sessionCwd: context.fingerprintIdentity.cwd,
        spawnCwd: undefined,
        tracingEnabled: false,
      };
    },
    async placeWorkspace(): Promise<PlacedWorkspace> {
      // The host runs in place, so it stages nothing and reports no referenced-
      // project staging failure.
      return { referencedProjectStagingFailures: [] };
    },
    async startTransport(): Promise<RunSiteTransport> {
      // The host lane starts no control bridge and no agent bridge.
      return { controlBridge: null, agentBridge: null };
    },
    reuse(): SessionReuseStore<RuntimeCacheEntry> {
      return store;
    },
    reuseCandidate(resources: ReadyRunResources): HostReuseCandidate {
      const runtime = resources.get("acp_runtime");
      if (!runtime) {
        throw new Error("host run site cannot name a reuse candidate without an acp_runtime resource");
      }
      return { runtime: runtime.runtime, sessionHandle: runtime.sessionHandle };
    },
    async syncBack(): Promise<void> {
      // The host runs in place, so there is nothing to sync back.
    },
  };
}
