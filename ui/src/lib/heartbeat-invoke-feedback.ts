type HeartbeatInvokeRunLike = {
  id: string;
};

type HeartbeatInvokeSkippedLike = {
  status: "skipped";
  reason?: string | null;
  message?: string | null;
};

export type HeartbeatInvokeResponseLike = HeartbeatInvokeRunLike | HeartbeatInvokeSkippedLike;

function defaultSkippedMessage(reason?: string | null) {
  switch (reason) {
    case "heartbeat.live_run_limit_reached":
      return "Heartbeat was skipped because this agent already has live work in flight.";
    case "heartbeat.wakeOnDemand.disabled":
      return "Heartbeat was skipped because this agent does not accept manual wakeups.";
    case "company.archived":
      return "Heartbeat was skipped because this company is archived.";
    default:
      return "Heartbeat was skipped.";
  }
}

export function describeHeartbeatInvokeResponse(response: HeartbeatInvokeResponseLike) {
  if ("id" in response) {
    return {
      kind: "run" as const,
      runId: response.id,
    };
  }

  return {
    kind: "skipped" as const,
    message: response.message?.trim() || defaultSkippedMessage(response.reason),
  };
}
