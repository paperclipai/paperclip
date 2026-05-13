import type { V1Job, V1Pod } from "@kubernetes/client-node";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

/**
 * Pure function: takes a terminal Job + Pod state and returns the
 * AdapterExecutionResult the driver should hand back to the caller.
 *
 * Mapping order matters — we check earlier (more specific) reasons first
 * so e.g. ImagePullBackOff is reported as image_pull_failed even though
 * Job.status.failed may also be ≥1 by the time we observe it.
 *
 * Recognised error codes (Spec §7.5):
 *   - image_pull_failed       (transient_upstream family)
 *   - workspace_init_failed
 *   - oom_killed
 *   - timeout
 *   - agent_exit_nonzero
 *   - unknown_terminal_state  (fallback when Job/Pod expose no terminal signal)
 */
export interface MapTerminalStateInput {
  job: V1Job;
  pod?: V1Pod;
}

export function mapTerminalState(input: MapTerminalStateInput): AdapterExecutionResult {
  const job = input.job;
  const pod = input.pod;

  // Success path — Job marked succeeded; surface the agent container's exit code.
  if ((job.status?.succeeded ?? 0) >= 1) {
    const main = pod?.status?.containerStatuses?.find((c) => c.name === "agent");
    return {
      exitCode: main?.state?.terminated?.exitCode ?? 0,
      signal: null,
      timedOut: false,
    };
  }

  const containers = pod?.status?.containerStatuses ?? [];
  const initContainers = pod?.status?.initContainerStatuses ?? [];

  // ImagePullBackOff — latched on container statuses (init or main). Transient
  // upstream so retryable per the existing AdapterExecutionErrorFamily rules.
  for (const c of [...containers, ...initContainers]) {
    const reason = c.state?.waiting?.reason;
    if (reason === "ImagePullBackOff" || reason === "ErrImagePull") {
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorCode: "image_pull_failed",
        errorFamily: "transient_upstream",
        errorMessage: `Image pull failed for container ${c.name}: ${c.state?.waiting?.message ?? reason}`,
      };
    }
  }

  // Init container terminal failure (e.g. workspace clone failed).
  for (const c of initContainers) {
    if (c.state?.terminated && c.state.terminated.exitCode !== 0) {
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorCode: "workspace_init_failed",
        errorMessage:
          `Init container ${c.name} exited ${c.state.terminated.exitCode}: ${c.state.terminated.reason ?? ""} ${c.state.terminated.message ?? ""}`.trim(),
      };
    }
  }

  // OOM killed — accept either the explicit reason or the conventional 137 exit code.
  for (const c of containers) {
    if (c.state?.terminated?.reason === "OOMKilled" || c.state?.terminated?.exitCode === 137) {
      return {
        exitCode: 137,
        signal: "SIGKILL",
        timedOut: false,
        errorCode: "oom_killed",
        errorMessage: `Container ${c.name} OOMKilled`,
      };
    }
  }

  // Job-level deadline exceeded — surfaces as `timedOut: true` for billing/retry policy.
  if (job.status?.conditions?.some((cond) => cond.type === "Failed" && cond.reason === "DeadlineExceeded")) {
    return {
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      errorCode: "timeout",
      errorMessage: "Job exceeded activeDeadlineSeconds",
    };
  }

  // Generic terminal failure — Job.status.failed ≥ 1 with no specific cause matched above.
  if ((job.status?.failed ?? 0) >= 1) {
    const main = containers.find((c) => c.name === "agent");
    const exit = main?.state?.terminated?.exitCode ?? null;
    return {
      exitCode: exit,
      signal: null,
      timedOut: false,
      errorCode: "agent_exit_nonzero",
      errorMessage: main?.state?.terminated?.message ?? `Agent exited ${exit}`,
    };
  }

  // No terminal state observed — driver should not hit this in normal operation.
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    errorCode: "unknown_terminal_state",
    errorMessage: "No terminal state observed on Job/Pod",
  };
}
