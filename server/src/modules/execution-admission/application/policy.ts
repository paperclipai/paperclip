import {
  applyTaskExecutionPolicyPatch,
  parseTaskExecutionPolicyPatch,
  type TaskExecutionPolicy,
} from "../domain/policy.js";

export type ProjectScope = { companyId: string; projectId: string };

export interface TaskExecutionPolicyStore {
  /** Null when the project is not in the company. */
  read(scope: ProjectScope): Promise<TaskExecutionPolicy | null>;
  /**
   * Locks the project in admission lock order and stores `change(current)`.
   * Returning `current` itself writes nothing. Null when the project is not in the company.
   */
  update(scope: ProjectScope, change: (current: TaskExecutionPolicy) => TaskExecutionPolicy): Promise<TaskExecutionPolicy | null>;
}

export type PolicyReadResult = { kind: "found"; policy: TaskExecutionPolicy } | { kind: "project_not_found" };

export type PolicyUpdateResult =
  | { kind: "updated" | "unchanged"; policy: TaskExecutionPolicy }
  | { kind: "invalid"; field: "policy" | "maxConcurrentTasks"; reason: string }
  | { kind: "project_not_found" };

/**
 * Internal policy commands. No route, tool or import calls `update` until
 * admission enforces the maximum; a cap written earlier would mislead users.
 */
export function createTaskExecutionPolicyCommands(store: TaskExecutionPolicyStore) {
  return {
    async readTaskExecutionPolicy(scope: ProjectScope): Promise<PolicyReadResult> {
      const policy = await store.read(scope);
      return policy ? { kind: "found", policy } : { kind: "project_not_found" };
    },

    async updateTaskExecutionPolicy(scope: ProjectScope, input: unknown): Promise<PolicyUpdateResult> {
      const parsed = parseTaskExecutionPolicyPatch(input);
      if (parsed.kind === "invalid") return parsed;
      let changed = false;
      const policy = await store.update(scope, current => {
        const next = applyTaskExecutionPolicyPatch(current, parsed.patch);
        changed = next !== current;
        return next;
      });
      if (!policy) return { kind: "project_not_found" };
      return { kind: changed ? "updated" : "unchanged", policy };
    },
  };
}
