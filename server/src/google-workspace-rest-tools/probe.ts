import { GoogleToolError, GoogleWorkspaceAuthError } from "./errors.js";
import { createGoogleHttp, type GoogleFetch, type GoogleRequest } from "./google-http.js";
import type { GoogleWorkspaceRestService } from "./tools.js";

const PROBES: Record<GoogleWorkspaceRestService, GoogleRequest> = {
  gmail: { method: "GET", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/profile" },
};

export interface GoogleWorkspaceRestProbeInput {
  service: GoogleWorkspaceRestService;
  accessToken: string;
  fetch?: GoogleFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type GoogleWorkspaceRestProbeResult = { ok: true } | { ok: false; message: string };

export async function probeGoogleWorkspaceRestService(input: GoogleWorkspaceRestProbeInput): Promise<GoogleWorkspaceRestProbeResult> {
  if (!input.accessToken) throw new GoogleWorkspaceAuthError("unauthenticated");
  const http = createGoogleHttp({ accessToken: input.accessToken, fetch: input.fetch, signal: input.signal, timeoutMs: input.timeoutMs });
  try {
    await http.send(PROBES[input.service]);
    return { ok: true };
  } catch (error) {
    if (error instanceof GoogleToolError) return { ok: false, message: error.message };
    throw error;
  }
}
