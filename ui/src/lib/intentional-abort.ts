// Abort reasons for requests the app cancels on purpose.
//
// The coalesced GET client aborts its shared fetch once every caller has left.
// Its own promise chain handles that rejection. Code outside the app that wraps
// `window.fetch` (a browser extension, an injected script) can still drop it,
// and the browser then reports the reason as an unhandled rejection. Marking
// each reason lets the error monitor tell this expected cancellation apart from
// a real abort failure by identity, without reading the rejected value.

const reasons = new WeakSet<object>();

/** A new AbortError that `isIntentionalAbortReason` recognizes. */
export function intentionalAbortReason(): DOMException {
  const reason = new DOMException("The operation was aborted.", "AbortError");
  reasons.add(reason);
  return reason;
}

export function isIntentionalAbortReason(value: unknown): boolean {
  return typeof value === "object" && value !== null && reasons.has(value);
}
