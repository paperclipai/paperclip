export type IsolatedRestartMode = "graceful" | "hard";
export interface IsolatedRestartRequest { requestId: string; mode: IsolatedRestartMode }

/** Only the private supervisor's own ChildProcess can be stopped. A request
 * cannot name a PID, command, host, or arbitrary signal. */
export function parseIsolatedRestartRequest(value: unknown): IsolatedRestartRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (typeof request.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(request.requestId) ||
      Object.keys(request).some(key => key !== "requestId" && key !== "mode") ||
      (request.mode !== undefined && request.mode !== "graceful" && request.mode !== "hard")) return null;
  return { requestId: request.requestId, mode: request.mode ?? "graceful" };
}
export function isolatedRestartSignal(mode: IsolatedRestartMode): "SIGTERM" | "SIGKILL" {
  if (mode === "hard") return "SIGKILL";
  if (mode === "graceful") return "SIGTERM";
  throw new Error("Invalid isolated controller restart mode");
}
