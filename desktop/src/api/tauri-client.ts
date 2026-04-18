import { invoke } from "@tauri-apps/api/core";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number = 500, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!IS_TAURI) {
    console.warn(`[dev] Skipping Tauri command: ${command}`);
    return [] as unknown as T;
  }
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw new ApiError(String(err));
  }
}
