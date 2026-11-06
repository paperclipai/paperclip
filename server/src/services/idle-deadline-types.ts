export const IDLE_DEADLINE_CATALOG = "domain_deadlines_v1" as const;
export interface IdleDeadlineReceipt {
  catalog: typeof IDLE_DEADLINE_CATALOG;
  generation: string;
}
export interface DomainScheduledWake {
  version: 2;
  kind: "domain_deadlines";
  catalog: typeof IDLE_DEADLINE_CATALOG;
  generation: string;
  nextWakeAt: string;
}
export interface IdleDeadlineSnapshot {
  blocked: boolean;
  state: unknown;
  deadlines: number[];
}
export const idleDeadlineRowLimit = 10_000;
export const isFutureIdleDeadline = (at: number, now: number) => Number.isFinite(at) && at > now;

export interface IdleDeadlineOwnerInspection {
  snapshot: IdleDeadlineSnapshot;
  current(): boolean;
  coverage?: IdleDeadlineCoverage;
  issueWaits?: readonly IdleIssueWait[];
}
export type IdleDeadlineOwnerReader = (
  tx: Pick<import("@paperclipai/db").Db, "select" | "execute">,
  now: number,
  checkBudget: () => void,
) => Promise<IdleDeadlineOwnerInspection>;
export type IdleDeadlineOwners = Partial<Record<"statusCards" | "externalObjects" | "skills" | "retries" | "watchdogs" | "quota", IdleDeadlineOwnerReader>>;

export type IdleIssueWait =
  | { kind: "scheduled_retry"; issueId: string; runId: string }
  | { kind: "provider_quota"; issueId: string; sourceRunId: string; targetAgentId: string; reviewer: boolean };
export type IdleDeadlineCoverage =
  | { kind: "status_cards" | "external_objects" | "skill_sources" | "watchdogs" }
  | { kind: "scheduled_retries"; runIds: string[]; wakeIds: string[] };
