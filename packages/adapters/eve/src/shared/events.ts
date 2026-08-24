/**
 * Eve NDJSON stream event. Kept intentionally loose — Eve may add event
 * types and fields at any time; consumers must parse defensively and never
 * throw on unknown event types or missing fields.
 */
export type EveStreamEvent = {
  type: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Wrapper events emitted to the Paperclip run transcript (one NDJSON line
 * each via onLog("stdout", ...)). The package's UI parser consumes these.
 */
export type EveInitEvent = {
  type: "eve.init";
  sessionId: string;
  baseUrl: string;
  model?: string;
};

export type EveEventEvent = {
  type: "eve.event";
  event: EveStreamEvent;
};

export type EveResultEvent = {
  type: "eve.result";
  status: string;
  summary?: string;
  error?: string;
};

export type EveWrapperEvent = EveInitEvent | EveEventEvent | EveResultEvent;
