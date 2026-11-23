export const NATIVE_RUN_PAYLOAD_TOO_LARGE = "native_run_payload_too_large" as const;

export const NATIVE_RUN_PAYLOAD_TOO_LARGE_ACTION =
  "This agent's run setup is too large to start, usually because it has too many connected tools. "
  + "Paperclip does not repeat this automatically, because the same setup would fail again. "
  + "Turn off connectors this agent does not need, then press Retry.";

export function isNativeRunPayloadTooLargeMessage(message: string): boolean {
  return /durable_prp_canonical_json_too_large|command_payload_too_large/.test(message);
}
