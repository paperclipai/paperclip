// Wake context is embedded in the OpenClaw gateway `message` as a fenced ```json
// block — the gateway rejects unknown root params, so there is no top-level
// `paperclip` field on the agent payload. Parse the block back out so tests can
// assert against the structured payload instead of raw JSON substrings, keeping
// them robust to serialization formatting/key-order changes.
export function parseWakePayloadFromMessage(message: unknown): Record<string, unknown> {
  const text = String(message ?? "");
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error(`Expected a wake JSON block in gateway message, got: ${text}`);
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}
