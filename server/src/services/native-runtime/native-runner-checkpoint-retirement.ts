const schema = "paperclip.native-runner-checkpoint-retirement.v1";
export const MAX_NATIVE_CHECKPOINT_RETIREMENT_RUNS = 100;
export type NativeCheckpointRetirement = {
  schema: typeof schema;
  companyId: string;
  agentId: string;
  sessionId: string;
  runIds: string[];
  retiredAt: string;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function readNativeCheckpointRetirement(
  value: unknown,
  binding: { companyId: string; runId: string },
): NativeCheckpointRetirement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.schema !== "string" ||
    !record.schema.startsWith("paperclip.native-runner-checkpoint-retirement.")
  )
    return null;
  if (
    record.schema !== schema ||
    Object.keys(record).sort().join(",") !==
      "agentId,companyId,retiredAt,runIds,schema,sessionId" ||
    record.companyId !== binding.companyId ||
    typeof record.agentId !== "string" ||
    !uuid.test(record.agentId) ||
    typeof record.sessionId !== "string" ||
    !record.sessionId ||
    record.sessionId.length > 4096 ||
    !Array.isArray(record.runIds) ||
    !record.runIds.length ||
    record.runIds.length > MAX_NATIVE_CHECKPOINT_RETIREMENT_RUNS ||
    !record.runIds.every((id) => typeof id === "string" && uuid.test(id)) ||
    new Set(record.runIds).size !== record.runIds.length ||
    !record.runIds.includes(binding.runId) ||
    typeof record.retiredAt !== "string" ||
    !Number.isFinite(Date.parse(record.retiredAt))
  ) {
    throw new Error("native_runner_checkpoint_retirement_invalid");
  }
  return record as NativeCheckpointRetirement;
}
export function nativeCheckpointRetirement(
  input: Omit<NativeCheckpointRetirement, "schema" | "retiredAt">,
): NativeCheckpointRetirement {
  const record: NativeCheckpointRetirement = {
    ...input,
    runIds: [...input.runIds],
    schema,
    retiredAt: new Date().toISOString(),
  };
  readNativeCheckpointRetirement(record, {
    companyId: input.companyId,
    runId: input.runIds[0],
  });
  return record;
}
