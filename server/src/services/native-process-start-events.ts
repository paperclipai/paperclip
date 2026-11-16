export const PROCESS_START_REQUESTED = "native.process_start_requested";
export const PROCESS_IDENTITY_RECORDED = "native.process_identity_recorded";

/** Server-authored events (no source event ID) that prove a run started its own process. */
export const OWN_PROCESS_START_EVENT_TYPES = [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED] as const;
