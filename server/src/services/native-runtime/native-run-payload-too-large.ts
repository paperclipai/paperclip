export const NATIVE_RUN_PAYLOAD_TOO_LARGE = "native_run_payload_too_large" as const;

export const NATIVE_RUN_PAYLOAD_TOO_LARGE_ACTION =
  "This agent's run setup is too large to start. Its connected tools, its instructions or its skills and context "
  + "together exceed what one run can carry. Paperclip does not repeat this automatically, because the same setup "
  + "would fail again. Turn off connectors or skills this agent does not need, or shorten its instructions, then press Retry.";

const RUN_PAYLOAD_TOO_LARGE = /durable_prp_canonical_json_too_large|command_payload_too_large/;

export function isNativeRunPayloadTooLarge(error: unknown, depth = 0): boolean {
  if (typeof error === "string") return RUN_PAYLOAD_TOO_LARGE.test(error);
  if (!error || typeof error !== "object" || depth > 5) return false;
  const value = error as { cause?: unknown; errors?: unknown; message?: unknown };
  if (typeof value.message === "string" && RUN_PAYLOAD_TOO_LARGE.test(value.message)) return true;
  return isNativeRunPayloadTooLarge(value.cause, depth + 1)
    || (Array.isArray(value.errors) && value.errors.slice(0, 3).some(item => isNativeRunPayloadTooLarge(item, depth + 1)));
}
