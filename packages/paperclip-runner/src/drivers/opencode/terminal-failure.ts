export const RUNNER_TERMINAL_FAILURE_CODES = {
  emptyResponse: "opencode_empty_response",
  outputLimit: "opencode_output_limit_reached",
  serverExited: "opencode_server_exited",
  eventStreamLost: "opencode_event_stream_lost",
} as const;
