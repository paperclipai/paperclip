// Bounds and cleans an error string before it's persisted to a durable
// audit/activity log. Needed anywhere the message can originate from an
// external system (an OAuth provider's error_description, a hook
// implementation's thrown error) rather than from this codebase's own
// exceptions -- an unbounded or control-character-laden string from such a
// source is a storage-sink and log-injection risk if logged raw.
//
// Only printable ASCII (0x20-0x7e) is kept; everything else -- control
// characters and all non-ASCII characters, including accented letters and
// other Unicode text -- is dropped outright, not escaped. This is a lossy
// transformation: e.g. "Ungültiger Token" becomes "Ungltiger Token". That
// loss is intentional and accepted here for log-safety, since this string
// is destined for a durable audit/activity log where the priority is a
// bounded, control-character-free value over full fidelity to the original
// message.
export function sanitizeLoggedProviderError(message: string): string {
  return message.replace(/[^\x20-\x7e]/g, "").slice(0, 512);
}
