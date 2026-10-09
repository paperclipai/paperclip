import { z } from "zod";
import type { PluginEnvironmentDriverBaseParams, PluginEnvironmentLease } from "./protocol.js";

// Provider IDs are opaque; providers validate their own addressing constraints.
const providerId = z.string().min(1);
// PRP identity.schema.json stableId.
const runnerIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
const secureUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "wss:" && !url.username && !url.password && !url.search && !url.hash;
}, "Expected a credential-free WSS URL");

/** One plugin-provided Runner execution attempt with a PRP connection. Secrets are transient RPC input. */
export const environmentTaskOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("submit"),
    projectIds: z.array(z.string().uuid()).max(64).refine(ids => new Set(ids).size === ids.length, "Duplicate project IDs"),
    runner: z.object({
      /** Inclusive PRP version range supported by the submitting client. */
      protocolMin: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      protocolMax: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      harness: identifier,
      runnerId: runnerIdentity, leaseId: runnerIdentity, runId: runnerIdentity,
      sessionId: runnerIdentity, turnId: runnerIdentity, itemId: runnerIdentity,
    }).strict().refine(value => value.protocolMin <= value.protocolMax, "Invalid PRP version range"),
    bootstrapTicket: z.string().min(1).max(65_536),
  }).strict(),
  z.object({ kind: z.literal("status") }).strict(),
  z.object({ kind: z.literal("connection") }).strict(),
  z.object({ kind: z.literal("complete") }).strict(),
  z.object({ kind: z.literal("stop") }).strict(),
]);

export const environmentTaskResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), taskId: providerId }).strict(),
  z.object({
    kind: z.literal("status"), taskId: providerId,
    phase: z.enum(["preparing", "running", "completed", "failed", "cancelled", "interrupted"]),
    exitCode: z.number().int().optional(),
    /** Provider observed the task and all descendants stopped; terminal phase alone is insufficient. */
    executionStopped: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal("connection"), taskId: providerId,
    endpoint: z.object({
      kind: z.literal("authenticated_websocket"), websocketUrl: secureUrl,
      generation: providerId,
      secretHeaders: z.array(z.object({
        name: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
        value: z.string().min(1).max(65_536).regex(/^[^\r\n]+$/),
      }).strict()).max(16),
    }).strict(),
  }).strict(),
]);

export type PluginEnvironmentTaskOperation = z.infer<typeof environmentTaskOperationSchema>;
export type PluginEnvironmentTaskResult = z.infer<typeof environmentTaskResultSchema>;

export interface PluginEnvironmentTaskParams extends Omit<PluginEnvironmentDriverBaseParams, "environmentId"> {
  /** Null during cleanup after the environment is deleted. */
  environmentId: string | null;
  lease: PluginEnvironmentLease;
  /** Provider-issued task identifier persisted in the lease, stable across ambiguous submission retries. */
  taskId: string;
  /** Null during cleanup after the associated run is deleted. */
  runId: string | null;
  agentId: string | null;
  /** Company-validated projects to prepare on submit; empty during cleanup. */
  projectIds: string[];
  operation: PluginEnvironmentTaskOperation;
}

/** An accepted stop is not proof of process termination. */
export function parseEnvironmentTaskResult(operation: PluginEnvironmentTaskOperation, taskId: string, value: unknown): PluginEnvironmentTaskResult {
  const result = environmentTaskResultSchema.parse(value);
  const expected = operation.kind === "status" || operation.kind === "connection" ? operation.kind : "accepted";
  if (result.taskId !== taskId || result.kind !== expected) throw new Error("Invalid plugin-provided Runner execution response");
  return result;
}
