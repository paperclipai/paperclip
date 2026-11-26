import type { HeartbeatRun, RunLivenessState } from "@paperclipai/shared";
import { StatusBadge } from "./StatusBadge";

const taskOutcomes: Record<RunLivenessState, string> = {
  advanced: "Progress recorded",
  blocked: "Blocked",
  completed: "Task closed",
  empty_response: "Incomplete",
  failed: "Failed",
  needs_followup: "Incomplete",
  plan_only: "Incomplete",
};

export function HeartbeatRunStatus({ run }: { run: Pick<HeartbeatRun, "status" | "livenessState"> }) {
  if (run.status !== "succeeded") return <StatusBadge status={run.status} />;
  const taskOutcome = run.livenessState ? taskOutcomes[run.livenessState] : null;
  return (
    <>
      {taskOutcome && <StatusBadge status={run.livenessState ?? "unknown"} label={taskOutcome} />}
      <StatusBadge status="process" label="Run succeeded" />
    </>
  );
}
