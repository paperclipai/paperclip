import { spawn } from "node:child_process";
import path from "node:path";

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

/** Keep exact process identities while their parents are still alive. Detached
 * runner/provider groups can be reparented before Playwright itself exits. */
export class OwnedProcessTree {
  #rootStarted: string | undefined;
  #groups: ObservedProcessGroup[] = [];

  constructor(readonly rootPid: number) {}

  observe(table: readonly ProcessObservation[], rootMayBeAlive: boolean) {
    const root = table.find((candidate) => candidate.pid === this.rootPid);
    if (this.#rootStarted === undefined && rootMayBeAlive && root) {
      this.#rootStarted = root.started;
    }
    const roots = new Map<number, number>();
    if (rootMayBeAlive && root && root.started === this.#rootStarted) {
      roots.set(root.pid, 0);
    }
    // Follow descendants of an already verified orphan as well, but never
    // accept a reused pid or group id as ownership evidence.
    const retained = revalidateObservedProcessGroups(this.#groups, table);
    const byPid = new Map(table.map((candidate) => [candidate.pid, candidate]));
    for (const group of retained) {
      for (const member of group.members) {
        const candidate = byPid.get(member.pid);
        if (
          candidate?.started === member.started &&
          candidate.processGroupId === group.processGroupId
        ) {
          roots.set(member.pid, Math.max(roots.get(member.pid) ?? 0, group.depth));
        }
      }
    }
    const groups = new Map(retained.map((group) => [
      group.processGroupId,
      {
        ...group,
        members: group.members.filter((member) => {
          const candidate = byPid.get(member.pid);
          return candidate?.started === member.started &&
            candidate.processGroupId === group.processGroupId;
        }),
      },
    ]));
    for (const [pid, depth] of roots) {
      for (const observed of observeDescendantProcessTree(table, pid).groups) {
        const group = groups.get(observed.processGroupId) ?? {
          processGroupId: observed.processGroupId,
          depth: depth + observed.depth,
          members: [],
        };
        for (const member of observed.members) {
          if (!group.members.some((existing) =>
            existing.pid === member.pid && existing.started === member.started
          )) group.members.push(member);
        }
        groups.set(group.processGroupId, group);
      }
    }
    this.#groups = [...groups.values()];
    return this.#groups;
  }

  get observedRoot(): boolean {
    return this.#rootStarted !== undefined;
  }

  get groups(): readonly ObservedProcessGroup[] {
    return this.#groups;
  }
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

const diagnosticProcessKinds = new Set([
  "bash",
  "chrome",
  "codex",
  "google-chrome",
  "node",
  "paperclip-runnerd",
  "playwright",
  "pnpm",
  "postgres",
  "sh",
  "tsx",
]);

export async function readProcessTable(): Promise<ProcessObservation[] | null> {
  if (process.platform === "win32") {
    return null;
  }
  return await new Promise<ProcessObservation[] | null>((resolve) => {
    const inspector = spawn(
      "ps",
      ["-e", "-o", "pid=,ppid=,pgid=,lstart=,comm="],
      {
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let output = "";
    let settled = false;
    const finish = (value: ProcessObservation[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(inspectionTimeout);
      resolve(value);
    };
    const inspectionTimeout = setTimeout(() => {
      inspector.kill("SIGKILL");
      finish(null);
    }, 5_000);
    inspectionTimeout.unref();
    inspector.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (output.length + chunk.length > 1024 * 1024) {
        finish(null);
        inspector.kill("SIGKILL");
      } else {
        output += chunk;
      }
    });
    inspector.once("error", () => finish(null));
    inspector.once("close", (code) => {
      if (code !== 0) return finish(null);
      const observations = output
        .split(/\r?\n/)
        .map((line) =>
          /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(
            line,
          ),
        )
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match): ProcessObservation => {
          // A target process can choose its own argv and process name. Emit a
          // fixed category instead of target-controlled text so diagnostics
          // can never turn that metadata into a secret-exfiltration channel.
          const command = path.basename(match[5]!);
          const kind = diagnosticProcessKinds.has(command) ? command : "other";
          return {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            processGroupId: Number(match[3]),
            started: match[4]!,
            kind,
          };
        });
      finish(observations);
    });
  }).catch(() => null);
}
