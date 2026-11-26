const reasons = new WeakSet<object>();

export function intentionalAbortReason(): DOMException {
  const reason = new DOMException("The operation was aborted.", "AbortError");
  reasons.add(reason);
  return reason;
}

export function isIntentionalAbortReason(value: unknown): boolean {
  return typeof value === "object" && value !== null && reasons.has(value);
}
