import type { ChildProcess } from "node:child_process";
import {
  observeDescendantProcessTree, readProcessTable, revalidateObservedProcessGroups,
  refreshContinuouslyLiveProcessGroups, safeProcessGroupTerminationOrder,
  type ObservedProcessGroup, type ProcessObservation,
} from "./process-tree.js";

/** Supplied by the company-scoped run API, never by process-name discovery. */
export interface RestartRunnerIdentity {
  processPid: number;
  processGroupId: number;
  processStartedAt: string;
}
export function parseRestartRunnerIdentity(value: unknown): RestartRunnerIdentity {
  const v = value as RestartRunnerIdentity | null;
  if (!v || !Number.isSafeInteger(v.processPid) || v.processPid <= 1
    || v.processGroupId !== v.processPid || typeof v.processStartedAt !== "string"
    || !Number.isFinite(Date.parse(v.processStartedAt))) throw new Error("Invalid restart runner identity");
  return { processPid: v.processPid, processGroupId: v.processGroupId, processStartedAt: v.processStartedAt };
}

/** Linux run receipts retain milliseconds; ps lstart retains whole seconds. */
export function restartProcessStartMatches(observed: string, expected: string, platform = process.platform): boolean {
  const actualTime = Date.parse(observed), expectedTime = Date.parse(expected);
  if (!Number.isFinite(actualTime) || !Number.isFinite(expectedTime)) return false;
  return platform === "linux"
    ? Math.floor(actualTime / 1000) === Math.floor(expectedTime / 1000)
    : actualTime === expectedTime;
}

export function createProcessTreeOwner(root: ChildProcess, options: {
  readTable?: () => Promise<ProcessObservation[] | null>;
  signalGroup?: (pid: number, signal: NodeJS.Signals) => void;
} = {}) {
  let groups: ObservedProcessGroup[] = [];
  let table: ProcessObservation[] = [];
  let rootStarted: string | undefined;
  let preserved: ObservedProcessGroup[] = [];
  let restartRunner: ProcessObservation | undefined;
  let observing: Promise<void> | undefined;
  const covered = new Set<number>();
  const readTable = options.readTable ?? readProcessTable;
  const signalGroup = options.signalGroup ?? ((pid, signal) => process.kill(-pid, signal));
  const exited = () => root.exitCode !== null || root.signalCode !== null || !root.pid;
  const running = (candidate: ProcessObservation) => !candidate.state?.startsWith("Z");

  function observe(): Promise<void> {
    if (process.platform === "win32") return Promise.resolve();
    if (observing) return observing;
    observing = (async () => {
      const next = await readTable();
      if (!next) throw new Error("Could not inspect owned process identities");
      const callerGroup = next.find(row => row.pid === process.pid)?.processGroupId;
      if (callerGroup === undefined) throw new Error("Cleanup caller group identity is unavailable");
      const rootRow = next.find(row => row.pid === root.pid);
      if (!rootStarted && !exited()) rootStarted = rootRow?.started;
      const retained = revalidateObservedProcessGroups(groups, next);
      const trustedAnchors = retained.flatMap(group => group.members
        .filter(member => next.some(row => row.pid === member.pid && row.started === member.started
          && row.processGroupId === group.processGroupId)).map(member => member.pid));
      if (rootRow && rootStarted === rootRow.started) trustedAnchors.push(rootRow.pid);
      const ownedNow = new Set(trustedAnchors.flatMap(pid =>
        observeDescendantProcessTree(next, pid).members.map(member => member.process.pid)));
      // A short-lived leader can exit between polls while its replacement
      // remains a descendant of a separately validated owner. Admit that
      // ancestry, never a recycled numeric group or a mixed ownership group.
      const lost = groups.filter(group => !retained.includes(group) && next.some(row => row.processGroupId === group.processGroupId && running(row)));
      const uncertain = lost.filter(group => next.some(row => row.processGroupId === group.processGroupId
        && running(row) && !ownedNow.has(row.pid)));
      if (uncertain.length) throw new Error(`Owned process group identity became uncertain: ${uncertain.map(group => group.processGroupId).join(",")}`);
      const refreshed = refreshContinuouslyLiveProcessGroups([...retained, ...lost], next)
        .filter(group => group.processGroupId !== callerGroup);
      const anchors = refreshed.flatMap(group => group.members.map(member => member.pid));
      if (rootRow && rootStarted === rootRow.started) anchors.push(rootRow.pid);
      const byGroup = new Map(refreshed.map(group => [group.processGroupId, group]));
      for (const pid of anchors) {
        for (const group of observeDescendantProcessTree(next, pid).groups) {
          if (group.processGroupId !== callerGroup) {
            byGroup.set(group.processGroupId, group);
            if (covered.has(next.find(row => row.pid === pid)!.processGroupId)) covered.add(group.processGroupId);
          }
        }
      }
      groups = [...byGroup.values()];
      // Follow only continuously owned members of the admitted daemon tree.
      // Orphaned descendants stay owned, but unrelated controller children do not.
      const retainedPreserved = refreshContinuouslyLiveProcessGroups(revalidateObservedProcessGroups(preserved, next), next);
      const preservedIds = new Set(retainedPreserved.map(group => group.processGroupId));
      for (const member of retainedPreserved.flatMap(group => group.members)) {
        for (const group of observeDescendantProcessTree(next, member.pid).groups) preservedIds.add(group.processGroupId);
      }
      preserved = groups.filter(group => preservedIds.has(group.processGroupId));
      table = next;
    })().finally(() => { observing = undefined; });
    return observing;
  }
  const timer = process.platform === "win32" ? undefined : setInterval(() => {
    void observe().catch(() => { /* Stop must obtain a fresh successful inspection. */ });
  }, 250);
  timer?.unref();
  void observe().catch(() => {});

  function liveGroups() {
    return groups.filter(group => table.some(row => row.processGroupId === group.processGroupId && running(row)));
  }
  async function preserveRunnerForRestart(identity: RestartRunnerIdentity) {
    const expected = parseRestartRunnerIdentity(identity);
    await observe();
    if (restartRunner || exited()) throw new Error("Restart runner admission must precede controller exit");
    const tree = observeDescendantProcessTree(table, root.pid!);
    const candidate = tree.members.map(member => member.process).find(row => row.pid === expected.processPid);
    if (!candidate || !running(candidate) || candidate.kind !== "paperclip-runnerd"
      || candidate.processGroupId !== expected.processGroupId
      || !restartProcessStartMatches(candidate.started, expected.processStartedAt)
      || candidate.processGroupId === root.pid) throw new Error("Restart runner is not the exact owned durable daemon");
    const subtree = observeDescendantProcessTree(table, candidate.pid);
    const members = new Set(subtree.members.map(member => member.process.pid));
    const ids = new Set(subtree.groups.map(group => group.processGroupId));
    if (table.some(row => ids.has(row.processGroupId) && !members.has(row.pid) && running(row))) {
      throw new Error("Restart runner shares a process group with an unrelated process");
    }
    restartRunner = { ...candidate };
    preserved = groups.filter(group => ids.has(group.processGroupId));
  }
  function assertRestartRunnerAlive() {
    if (!restartRunner || !table.some(row => row.pid === restartRunner!.pid && row.started === restartRunner!.started
      && row.processGroupId === restartRunner!.processGroupId && running(row))) throw new Error("Admitted restart runner did not survive controller restart");
  }
  function restartCleanupGroups() {
    const ids = new Set(preserved.map(group => group.processGroupId));
    return new Set(liveGroups().filter(group => !ids.has(group.processGroupId)).map(group => group.processGroupId));
  }
  function signalSnapshot(signal: NodeJS.Signals, selected?: ReadonlySet<number>) {
    const currentProcessGroupId = table.find(row => row.pid === process.pid)?.processGroupId ?? null;
    if (currentProcessGroupId === null) throw new Error("Cleanup caller group identity is unavailable");
    const live = liveGroups();
    const ordered = safeProcessGroupTerminationOrder({ rootProcessGroupId: root.pid ?? -1, currentProcessGroupId, groups: live });
    const signaled: number[] = [];
    for (const pid of ordered) {
      if (selected && !selected.has(pid)) continue;
      try { signalGroup(pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; else continue; }
      signaled.push(pid);
    }
    return signaled;
  }
  async function signal(signal: NodeJS.Signals, selected?: ReadonlySet<number>) {
    await observe();
    return signalSnapshot(signal, selected);
  }
  function gracefulRoots() {
    const live = liveGroups();
    const ids = new Set(live.map(group => group.processGroupId));
    if (root.pid && ids.has(root.pid)) return new Set([root.pid]);
    // After the launcher's leader exits, request shutdown only from the
    // outermost remaining owners; their wrappers still own child signaling.
    const byPid = new Map(table.map(row => [row.pid, row]));
    return new Set(live.filter(group => !table.some(row => {
      if (row.processGroupId !== group.processGroupId) return false;
      const seen = new Set<number>();
      let parent = byPid.get(row.parentPid);
      while (parent && !seen.has(parent.pid)) {
        seen.add(parent.pid);
        if (parent.processGroupId !== group.processGroupId && ids.has(parent.processGroupId)) return true;
        parent = byPid.get(parent.parentPid);
      }
      return false;
    })).map(group => group.processGroupId));
  }
  let graceComplete = false;
  let directGraceDelivered = false;
  async function signalGracefully() {
    if (graceComplete) return;
    await observe();
    // Choose and deliver from one validated table. ESRCH grants no ownership
    // coverage: the next grace poll can select that branch's surviving owner.
    const selected = new Set([...gracefulRoots()].filter(pid => !covered.has(pid)));
    const delivered = signalSnapshot("SIGTERM", selected);
    for (const pid of delivered) {
      if (pid === root.pid) directGraceDelivered = true;
      covered.add(pid);
      for (const member of table.filter(row => row.processGroupId === pid)) {
        for (const group of observeDescendantProcessTree(table, member.pid).groups) covered.add(group.processGroupId);
      }
    }
    // Never reselect descendants after their owner received grace, even if it
    // exits before their asynchronous close completes.
    graceComplete = selected.size > 0 && delivered.length === selected.size;
  }
  return { observe, signal, liveGroups, gracefulRoots, signalGracefully,
    preserveRunnerForRestart, assertRestartRunnerAlive, restartCleanupGroups,
    directGraceDelivered: () => directGraceDelivered, stopObserving: () => { if (timer) clearInterval(timer); } };
}


/** Inspection failure grants no group authority. The unreaped ChildProcess
 * handle still owns its direct child, so retire only that child within the
 * original grace deadline, then report the incomplete tree audit. */
export async function stopKnownDirectChild(child: ChildProcess, phase: { gracefulSent: boolean; forcedDeadline?: number },
  deadline: number, forcedMs: number, signal: NodeJS.Signals = "SIGTERM") {
  const exited = () => child.exitCode !== null || child.signalCode !== null || !child.pid;
  const wait = () => new Promise(resolve => setTimeout(resolve, 25));
  if (!exited() && !phase.gracefulSent) {
    phase.gracefulSent = child.kill(signal);
  }
  while (!exited() && Date.now() < deadline) await wait();
  if (exited()) return;
  child.kill("SIGKILL");
  phase.forcedDeadline ??= Date.now() + forcedMs;
  while (!exited() && Date.now() < phase.forcedDeadline) await wait();
  if (!exited()) throw new Error("Known direct child remained after bounded fallback");
}

export async function incompleteTreeFallback(error: unknown, child: ChildProcess,
  phase: { gracefulSent: boolean; forcedDeadline?: number }, deadline: number, forcedMs: number) {
  let fallbackError: unknown;
  try { await stopKnownDirectChild(child, phase, deadline, forcedMs); }
  catch (failure) { fallbackError = failure; }
  throw new Error(`Owned tree cleanup incomplete: ${String(error)}${fallbackError ? `; ${String(fallbackError)}` : ""}`);
}

/** Give the launcher/wrapper chain sole graceful-signal ownership, then retire
 * only still-observed descendants. Used on normal exit as well as cancellation. */
export async function stopOwnedProcessTree(
  child: ChildProcess,
  owner: ReturnType<typeof createProcessTreeOwner>,
  gracefulMs = 45_000,
  forcedMs = 5_000,
): Promise<void> {
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = Date.now() + gracefulMs;
  const phase: { gracefulSent: boolean; forcedDeadline?: number } = { gracefulSent: false };
  try {
    if (process.platform === "win32") {
      await stopKnownDirectChild(child, phase, deadline, forcedMs);
      return;
    }
    const stopped = async () => {
      await owner.observe();
      return (child.exitCode !== null || child.signalCode !== null) && owner.liveGroups().length === 0;
    };
    do {
      await owner.signalGracefully();
      phase.gracefulSent ||= owner.directGraceDelivered();
      if (await stopped()) return;
      await wait(50);
    } while (Date.now() < deadline);
    await owner.signal("SIGKILL");
    phase.forcedDeadline = Date.now() + forcedMs;
    do {
      if (await stopped()) return;
      await wait(50);
    } while (Date.now() < phase.forcedDeadline);
    throw new Error("Observed launcher descendants remained after bounded cleanup");
  } catch (error) {
    phase.gracefulSent ||= owner.directGraceDelivered();
    await incompleteTreeFallback(error, child, phase, deadline, forcedMs);
  }
}
