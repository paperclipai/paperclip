import {
  requestCheckboxConfirmationPayloadSchema,
  requestCheckboxConfirmationResultSchema,
  requestConfirmationPayloadSchema,
  requestConfirmationResultSchema,
  type RequestCheckboxConfirmationOption,
} from "@paperclipai/shared";

export function readPersistedConfirmationDecision(row: {
  kind: string;
  status: string;
  payload: unknown;
  result: unknown;
  resolvedAt: Date | null;
}) {
  if ((row.kind !== "request_confirmation" && row.kind !== "request_checkbox_confirmation")
    || (row.status !== "accepted" && row.status !== "rejected") || !row.resolvedAt) return null;
  const checkbox = row.kind === "request_checkbox_confirmation";
  const payload = checkbox ? requestCheckboxConfirmationPayloadSchema.safeParse(row.payload)
    : requestConfirmationPayloadSchema.safeParse(row.payload);
  const result = checkbox ? requestCheckboxConfirmationResultSchema.safeParse(row.result)
    : requestConfirmationResultSchema.safeParse(row.result);
  if (!payload.success || !result.success || result.data.outcome !== row.status) return null;
  let approvedOptions: RequestCheckboxConfirmationOption[] | null = null;
  if (checkbox && row.status === "accepted") {
    if (!("options" in payload.data) || !("selectedOptionIds" in result.data)) return null;
    const selected = result.data.selectedOptionIds;
    const allowed = new Set(payload.data.options.map(option => option.id));
    if (!Array.isArray(selected) || selected.length === 0 || selected.some(id => !allowed.has(id))
      || selected.length < payload.data.minSelected
      || (payload.data.maxSelected != null && selected.length > payload.data.maxSelected)) return null;
    const options = new Map(payload.data.options.map(option => [option.id, option]));
    approvedOptions = selected.map(id => options.get(id)!);
  }
  return { outcome: row.status, target: payload.data.target ?? null, commentId: result.data.commentId, approvedOptions } as const;
}
