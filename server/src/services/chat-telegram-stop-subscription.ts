/** Closed, credential-free preservation plan for an already-managed webhook. */
function telegramWebhookSettings(
  value: unknown,
  expectedUrl: string,
): { allowed_updates: string[]; max_connections: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const info = value as Record<string, unknown>;
  if (info.url !== expectedUrl || info.has_custom_certificate !== false)
    return null;
  const maxConnections =
    info.max_connections === undefined ? 40 : info.max_connections;
  if (
    !Number.isSafeInteger(maxConnections) ||
    Number(maxConnections) < 1 ||
    Number(maxConnections) > 100
  )
    return null;
  const updates =
    info.allowed_updates === undefined ? [] : info.allowed_updates;
  if (
    !Array.isArray(updates) ||
    updates.length > 256 ||
    updates.some(
      (name) =>
        typeof name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(name),
    )
  )
    return null;
  return {
    allowed_updates: [...updates],
    max_connections: Number(maxConnections),
  };
}

export function telegramStopSubscriptionPlan(
  value: unknown,
  expectedUrl: string,
) {
  const settings = telegramWebhookSettings(value, expectedUrl);
  if (!settings) return null;
  const updates = settings.allowed_updates;
  // Explicit [] preserves Telegram's default subscription, which includes
  // Stop but excludes three opt-in member/reaction events. Omitting the SET
  // argument instead would retain an unobserved concurrently changed list.
  const allowed_updates =
    updates.length === 0 || updates.includes("stopped_message_generation")
      ? [...updates]
      : [...updates, "stopped_message_generation"];
  // Observed ip_address does not prove an operator supplied an explicit pin.
  // Paperclip-managed webhook setup uses DNS; do not turn it into a new pin.
  return { ...settings, allowed_updates };
}

export function telegramStopSubscriptionConfirmed(
  value: unknown,
  expectedUrl: string,
  requested: NonNullable<ReturnType<typeof telegramStopSubscriptionPlan>>,
): boolean {
  const observed = telegramWebhookSettings(value, expectedUrl);
  // Verification must compare the raw observed settings, not the upgrading
  // plan: the latter intentionally adds Stop even when the provider lacks it.
  return (
    !!observed &&
    observed.max_connections === requested.max_connections &&
    JSON.stringify([...new Set(observed.allowed_updates)].sort()) ===
      JSON.stringify([...new Set(requested.allowed_updates)].sort())
  );
}
