/** Constructor failures do not dispatch socket events. Callers must use their
 * disconnected fallback and retry path when this returns null. */
export function tryCreateWebSocket(url: string): WebSocket | null {
  try {
    return new WebSocket(url);
  } catch {
    return null;
  }
}
