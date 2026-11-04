import type { Db } from "@paperclipai/db";
import { createPostgresTaskExecutionPolicyStore } from "./adapters/postgres.js";
import { createTaskExecutionPolicyCommands } from "./application/policy.js";

export type { TaskExecutionPolicy, TaskExecutionPolicyPatch } from "./domain/policy.js";
export type { PolicyReadResult, PolicyUpdateResult, ProjectScope } from "./application/policy.js";
export type { RetainedSessionProjects } from "./domain/admission.js";
export { MAX_ADMISSION_PROJECTS } from "./domain/admission.js";
// Lifecycle guards run inside the caller's deletion transaction.
export { deleteAgentAdmissionHistory, hasUnsettledProjectCharges } from "./adapters/postgres.js";
// The task-context owner revalidates a retained session's admitted references.
export { readRetainedSessionProjects } from "./adapters/postgres.js";

/**
 * Execution admission owns project task-execution policy and the durable
 * admission epochs that charge project capacity. Admission and settlement
 * commands are not composed yet; nothing enforces the maximum.
 */
export function createExecutionAdmission(db: Db) {
  return createTaskExecutionPolicyCommands(createPostgresTaskExecutionPolicyStore(db));
}
