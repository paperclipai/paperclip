export interface ProcessObservation {
  pid: number;
  parentPid: number;
  processGroupId: number;
  started: string;
  kind: string;
}

export interface ObservedProcessGroup {
  processGroupId: number;
  depth: number;
  members: Array<Pick<ProcessObservation, "pid" | "started">>;
}

export interface ObservedProcessTreeMember {
  process: ProcessObservation;
  depth: number;
}

export function observeDescendantProcessTree(
  table: readonly ProcessObservation[],
  rootPid: number,
) {
  const byPid = new Map(table.map((candidate) => [candidate.pid, candidate]));
  const byParent = new Map<number, ProcessObservation[]>();
  for (const candidate of table) {
    const children = byParent.get(candidate.parentPid) ?? [];
    children.push(candidate);
    byParent.set(candidate.parentPid, children);
  }
  const observed = new Map<number, ObservedProcessTreeMember>();
  const pending = [{ pid: rootPid, depth: 0 }];
  while (pending.length > 0) {
    const next = pending.shift()!;
    if (observed.has(next.pid)) continue;
    const candidate = byPid.get(next.pid);
    if (!candidate) continue;
    observed.set(next.pid, { process: candidate, depth: next.depth });
    for (const child of byParent.get(next.pid) ?? []) {
      pending.push({ pid: child.pid, depth: next.depth + 1 });
    }
  }
  const groupsById = new Map<number, ObservedProcessGroup>();
  for (const { process: candidate, depth } of observed.values()) {
    const group = groupsById.get(candidate.processGroupId) ?? {
      processGroupId: candidate.processGroupId,
      depth,
      members: [],
    };
    group.depth = Math.max(group.depth, depth);
    group.members.push({ pid: candidate.pid, started: candidate.started });
    groupsById.set(candidate.processGroupId, group);
  }
  return {
    members: [...observed.values()].sort(
      (left, right) => left.depth - right.depth,
    ),
    groups: [...groupsById.values()].sort(
      (left, right) => right.depth - left.depth,
    ),
  };
}

export function safeProcessGroupTerminationOrder(input: {
  rootProcessGroupId: number;
  currentProcessGroupId: number | null;
  groups: readonly ObservedProcessGroup[];
}) {
  if (input.currentProcessGroupId === null) return [];
  const safe = new Map<number, number>();
  for (const group of input.groups) {
    if (
      group.processGroupId <= 1 ||
      group.processGroupId === input.currentProcessGroupId
    ) {
      continue;
    }
    safe.set(
      group.processGroupId,
      Math.max(safe.get(group.processGroupId) ?? -1, group.depth),
    );
  }
  if (
    input.rootProcessGroupId > 1 &&
    input.rootProcessGroupId !== input.currentProcessGroupId &&
    input.groups.some(
      (group) => group.processGroupId === input.rootProcessGroupId,
    )
  ) {
    safe.set(input.rootProcessGroupId, -1);
  }
  return [...safe.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([processGroupId]) => processGroupId);
}

export function revalidateObservedProcessGroups(
  groups: readonly ObservedProcessGroup[],
  table: readonly ProcessObservation[],
) {
  const byPid = new Map(table.map((candidate) => [candidate.pid, candidate]));
  return groups.filter((group) =>
    group.members.some((member) => {
      const candidate = byPid.get(member.pid);
      return (
        candidate?.processGroupId === group.processGroupId &&
        candidate.started === member.started
      );
    }),
  );
}

/**
 * Refresh groups only after their original members have been revalidated.
 * A process may replace itself or fork a final cleanup helper after SIGTERM.
 * Retain that continuously live group until one poll observes it as empty.
 */
export function refreshContinuouslyLiveProcessGroups(
  groups: readonly ObservedProcessGroup[],
  table: readonly ProcessObservation[],
) {
  const membersByGroup = new Map<number, ProcessObservation[]>();
  for (const candidate of table) {
    const members = membersByGroup.get(candidate.processGroupId) ?? [];
    members.push(candidate);
    membersByGroup.set(candidate.processGroupId, members);
  }
  return groups.flatMap((group) => {
    const members = membersByGroup.get(group.processGroupId);
    return members
      ? [
          {
            ...group,
            members: members.map((candidate) => ({
              pid: candidate.pid,
              started: candidate.started,
            })),
          },
        ]
      : [];
  });
}
