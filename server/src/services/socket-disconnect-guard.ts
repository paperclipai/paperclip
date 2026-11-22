const RECOVERABLE_SOCKET_CODES = new Set(["EPIPE"]);

export function isRecoverableSocketDisconnect(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; syscall?: unknown };
  if (typeof candidate.code !== "string" || !RECOVERABLE_SOCKET_CODES.has(candidate.code)) {
    return false;
  }
  return candidate.syscall === undefined || candidate.syscall === "write";
}

export type SocketDisconnectWarn = (error: unknown) => void;

export function createSocketDisconnectGuard(warn: SocketDisconnectWarn) {
  const handler = (error: unknown): void => {
    if (isRecoverableSocketDisconnect(error)) {
      warn(error);
      return;
    }
    process.removeListener("uncaughtException", handler);
    process.nextTick(() => { throw error; });
  };
  return handler;
}

export function installSocketDisconnectGuard(warn: SocketDisconnectWarn): () => void {
  const handler = createSocketDisconnectGuard(warn);
  process.on("uncaughtException", handler);
  return () => process.removeListener("uncaughtException", handler);
}
