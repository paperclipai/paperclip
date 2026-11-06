export function requiresSignedNativeReviewCredential(
  actor: { type: string; source?: string },
  interaction: { kind: string; payload: unknown },
): boolean {
  if (actor.type !== "agent" || actor.source === "agent_jwt" || interaction.kind !== "request_confirmation") return false;
  const payload = interaction.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const target = (payload as Record<string, unknown>).target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return false;
  const value = target as Record<string, unknown>;
  return value.type === "custom" && value.key === "native_completion_review";
}
