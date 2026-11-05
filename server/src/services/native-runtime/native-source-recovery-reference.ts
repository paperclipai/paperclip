import { environmentTaskOperationSchema, type PluginEnvironmentTaskOperation } from "@paperclipai/plugin-sdk";

type Identity = Extract<PluginEnvironmentTaskOperation, { kind: "prepare" }>["requirements"]["identity"];
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export type PluginTaskSourceRecovery = {
  schema: "paperclip.runner.source-recovery.v1";
  resumeFrom: string;
  sourceLeaseId: string;
  identity: Identity;
  consumerLeaseId: string;
  consumerRunId: string;
  controllerBootId: string;
  controllerGeneration: number;
  contextId: string;
  accountIdentity: string;
  sourceProfileSha256: string;
  consumerProfileSha256: string;
};

export function readPluginTaskSourceRecovery(value: unknown): PluginTaskSourceRecovery | null {
  const v = record(value);
  const identity = environmentTaskOperationSchema.safeParse({ kind: "read_state", identity: v.identity });
  return v.schema === "paperclip.runner.source-recovery.v1" && identity.success &&
    ["resumeFrom", "sourceLeaseId", "consumerLeaseId", "consumerRunId", "controllerBootId", "contextId", "accountIdentity"].every(key => typeof v[key] === "string" && v[key] !== "") &&
    Number.isSafeInteger(v.controllerGeneration) && Number(v.controllerGeneration) >= 0 &&
    [v.sourceProfileSha256, v.consumerProfileSha256].every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
    ? v as unknown as PluginTaskSourceRecovery : null;
}
