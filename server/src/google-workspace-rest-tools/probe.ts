import { CALENDAR_BASE, CALENDAR_HOST } from "./calendar/event.js";
import { calendarProbeRequest } from "./calendar/list-calendars.js";
import { freeBusyRequest } from "./calendar/suggest-time.js";
import { GoogleToolError, GoogleWorkspaceAuthError } from "./errors.js";
import { createGoogleHttp, type GoogleFetch, type GoogleRequest } from "./google-http.js";
import type { GoogleWorkspaceRestService } from "./tools.js";

const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
const PROBE_WINDOW_MS = 60_000;

interface ProbeCandidate {
  anyOfScopes: readonly string[];
  request(now: number): GoogleRequest;
}

export const GOOGLE_WORKSPACE_REST_PROBES: Readonly<Record<GoogleWorkspaceRestService, readonly ProbeCandidate[]>> = {
  gmail: [
    {
      anyOfScopes: [scope("gmail.readonly")],
      request: () => ({ method: "GET", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/profile" }),
    },
  ],
  calendar: [
    {
      anyOfScopes: [scope("calendar.calendarlist.readonly"), scope("calendar.readonly")],
      request: () => calendarProbeRequest(),
    },
    {
      anyOfScopes: [scope("calendar.events.readonly"), scope("calendar.events"), scope("calendar.readonly")],
      request: () => ({
        method: "GET", host: CALENDAR_HOST, path: `${CALENDAR_BASE}/calendars/primary/events`,
        query: { maxResults: 1, fields: "items(id)" },
      }),
    },
    {
      anyOfScopes: [scope("calendar.events.freebusy")],
      request: (now) => freeBusyRequest(["primary"], { start: now, end: now + PROBE_WINDOW_MS }, "UTC"),
    },
  ],
  docs: [],
  slides: [],
  sheets: [],
};

export function googleWorkspaceRestProbeFor(service: GoogleWorkspaceRestService, grantedScopes: readonly string[]): ProbeCandidate | null {
  return GOOGLE_WORKSPACE_REST_PROBES[service].find((candidate) => candidate.anyOfScopes.some((granted) => grantedScopes.includes(granted))) ?? null;
}

export interface GoogleWorkspaceRestProbeInput {
  service: GoogleWorkspaceRestService;
  accessToken: string;
  grantedScopes: readonly string[];
  fetch?: GoogleFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: number;
}

export type GoogleWorkspaceRestProbeResult =
  | { ok: true; probed: boolean }
  | { ok: false; message: string };

export async function probeGoogleWorkspaceRestService(input: GoogleWorkspaceRestProbeInput): Promise<GoogleWorkspaceRestProbeResult> {
  const candidate = googleWorkspaceRestProbeFor(input.service, input.grantedScopes);
  if (!candidate) return { ok: true, probed: false };
  if (!input.accessToken) throw new GoogleWorkspaceAuthError("unauthenticated");
  const http = createGoogleHttp({ accessToken: input.accessToken, fetch: input.fetch, signal: input.signal, timeoutMs: input.timeoutMs });
  try {
    await http.send(candidate.request(input.now ?? Date.now()));
    return { ok: true, probed: true };
  } catch (error) {
    if (error instanceof GoogleWorkspaceAuthError && error.reason === "insufficient_scope") return { ok: true, probed: true };
    if (error instanceof GoogleToolError) return { ok: false, message: error.message };
    throw error;
  }
}
