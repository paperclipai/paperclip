import { incomingReadyAt, startedBy, type SwapRecord } from "./release-swap-driver.js";

export const SWAP_MOMENTS = ["incoming_spawned", "incoming_ready", "traffic_switched", "outgoing_sigterm", "outgoing_exited"] as const;
export type SwapMoment = (typeof SWAP_MOMENTS)[number];

export function swapMoments(swap: Pick<SwapRecord, "spawnedAt" | "switchedAt" | "stopRequestedAt" | "stoppedAt" | "incomingPhases">): Record<SwapMoment, number | null> {
  return {
    incoming_spawned: swap.spawnedAt,
    incoming_ready: swap.switchedAt === null ? swap.incomingPhases.find(phase => phase.phase === "ready")?.at ?? null : incomingReadyAt(swap, swap.switchedAt),
    traffic_switched: swap.switchedAt,
    outgoing_sigterm: swap.stopRequestedAt,
    outgoing_exited: swap.stoppedAt,
  };
}

export interface RunInSwap {
  runId: string;
  issueId: string | null;
  startedAt: number;
  after: SwapMoment;
  before: SwapMoment | "after_swap";
  startedBy: "old" | "new" | "unknown";
}

export function runsStartedDuringSwap(swap: SwapRecord): RunInSwap[] {
  const moments = swapMoments(swap);
  const ordered = SWAP_MOMENTS.flatMap(name => moments[name] === null ? [] : [{ name, at: moments[name]! }]);
  if (!ordered.length) return [];
  const from = ordered[0]!.at;
  const to = ordered[ordered.length - 1]!.at;
  return Object.values(swap.runs)
    .filter(trace => trace.startedAt !== null && trace.startedAt >= from && trace.startedAt <= to)
    .sort((left, right) => left.startedAt! - right.startedAt!)
    .map(trace => {
      const after = [...ordered].reverse().find(moment => moment.at <= trace.startedAt!)!;
      const before = ordered.find(moment => moment.at > trace.startedAt!);
      return { runId: trace.runId, issueId: trace.issueId, startedAt: trace.startedAt!, after: after.name, before: before?.name ?? "after_swap", startedBy: startedBy(trace, swap) };
    });
}

export function swapMomentsMarkdown(swaps: readonly SwapRecord[]): string[] {
  const time = (at: number | null) => at === null ? "–" : new Date(at).toISOString().slice(11, 23);
  const server = (by: RunInSwap["startedBy"]) => by === "old" ? "outgoing server" : by === "new" ? "incoming server" : "unknown server";
  return [
    `| Swap | ${SWAP_MOMENTS.join(" | ")} |`,
    `| --- |${SWAP_MOMENTS.map(() => " --- |").join("")}`,
    ...swaps.map(swap => {
      const moments = swapMoments(swap);
      return `| ${swap.index} | ${SWAP_MOMENTS.map(name => time(moments[name])).join(" | ")} |`;
    }),
    "",
    ...swaps.flatMap(swap => runsStartedDuringSwap(swap).map(run =>
      `- Swap ${swap.index}: run ${run.runId} started ${time(run.startedAt)}, between ${run.after} and ${run.before}, by the ${server(run.startedBy)}`)),
  ];
}
