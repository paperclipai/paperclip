import { ChaosApiError, type ChaosApi } from "./api.js";

export const REMOTE_FILE_WAIT_MS = 4 * 60_000;
export const REMOTE_FILE_POLL_MS = 2_000;

function contentRoute(issueId: string, relative: string): string {
  return `/api/issues/${issueId}/file-resources/content?path=${encodeURIComponent(relative)}&workspace=execution&download=true`;
}

export async function readRemoteWorkspaceFile(api: Pick<ChaosApi, "getText">, issueId: string, relative: string,
  options: { waitMs?: number; pollMs?: number; onError?: (message: string) => void } = {}): Promise<string | null> {
  const deadline = Date.now() + (options.waitMs ?? REMOTE_FILE_WAIT_MS);
  for (;;) {
    let unavailable = false;
    const text = await api.getText(contentRoute(issueId, relative), 15_000).catch((error: unknown) => {
      unavailable = error instanceof ChaosApiError && error.status === 422;
      options.onError?.((error instanceof Error ? error.message : String(error)).slice(0, 400));
      return null;
    });
    if (text !== null || !unavailable || Date.now() >= deadline) return text;
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? REMOTE_FILE_POLL_MS));
  }
}

export async function captureRemoteWorkspaceFiles(api: Pick<ChaosApi, "getText">, issueId: string, wanted: readonly string[],
  captured: Record<string, string | null>, onError?: (relative: string, message: string) => void): Promise<void> {
  for (const relative of wanted) {
    if (typeof captured[relative] === "string") continue;
    captured[relative] = await readRemoteWorkspaceFile(api, issueId, relative, { waitMs: 0, ...(onError ? { onError: message => onError(relative, message) } : {}) });
  }
}
