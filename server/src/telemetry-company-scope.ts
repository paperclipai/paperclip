import { AsyncLocalStorage } from "node:async_hooks";

export type TelemetryPersonAttribution = "task_creator" | "task_assigner" | "run_owner";

export type TelemetryPerson = {
  userId: string;
  attributedVia: TelemetryPersonAttribution;
};

type TelemetryScope = {
  companyId?: string;
  person?: TelemetryPerson;
};

const storage = new AsyncLocalStorage<TelemetryScope>();
const NON_PERSON_USER_IDS = new Set(["local-board"]);

export function withTelemetryCompany<T>(companyId: string | null | undefined, fn: () => T): T {
  return withTelemetryActor({ companyId }, fn);
}

export function withTelemetryActor<T>(
  scope: { companyId?: string | null; person?: TelemetryPerson | null },
  fn: () => T,
): T {
  const next: TelemetryScope = {};
  if (scope.companyId) next.companyId = scope.companyId;
  if (scope.person) next.person = scope.person;
  return next.companyId || next.person ? storage.run(next, fn) : fn();
}

export function scopedTelemetryCompanyId(): string | undefined {
  return storage.getStore()?.companyId;
}

export function scopedTelemetryPerson(): TelemetryPerson | undefined {
  return storage.getStore()?.person;
}

function personUserId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && !NON_PERSON_USER_IDS.has(trimmed) ? trimmed : null;
}

export function resolveTelemetryPerson(input: {
  taskCreatedByUserId?: string | null;
  taskAssignedByUserId?: string | null;
  runOwnerUserId?: string | null;
}): TelemetryPerson | null {
  const creator = personUserId(input.taskCreatedByUserId);
  if (creator) return { userId: creator, attributedVia: "task_creator" };
  const assigner = personUserId(input.taskAssignedByUserId);
  if (assigner) return { userId: assigner, attributedVia: "task_assigner" };
  const runOwner = personUserId(input.runOwnerUserId);
  if (runOwner) return { userId: runOwner, attributedVia: "run_owner" };
  return null;
}
