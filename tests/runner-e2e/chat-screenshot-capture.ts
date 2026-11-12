type Capture = (id: string, label: string, file: string) => Promise<void>;
/** Ordinary catalog chats retain genuine screenshots as private Actions evidence.
 * Canonical agent slugs and legitimate result navigation are not public routes.
 * All other suites still use their existing reviewed public capture guard. */
export function ordinaryChatCapture(
  suiteId: string,
  capturePrivate: (id: string, file: string) => Promise<void>,
  captureReviewedPublic: Capture,
): Capture {
  return suiteId === "chat-features"
    ? (id, _label, file) => capturePrivate(id, file)
    : captureReviewedPublic;
}
