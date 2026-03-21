/**
 * Detect whether the app is running inside a Tauri native shell.
 */
export function isTauriApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
