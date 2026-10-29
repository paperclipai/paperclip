export function parseTelegramApprovalActor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const actor = value.trim();
  return /^telegram:[A-Za-z0-9_-]+$/.test(actor) ? actor : null;
}
