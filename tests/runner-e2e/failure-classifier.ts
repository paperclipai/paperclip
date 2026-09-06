import type { FailureClass } from "./types.js";

const TRANSIENT =
  /(?:\b429\b|\b5\d\d\b|rate.?limit|ECONN(?:RESET|REFUSED)|socket hang up|network (?:error|interruption|timeout)|service unavailable|(?:provider|server|bootstrap|browser|webserver|health|daytona|sandbox|ingress|preview|connection|harness).*(?:temporar|timed? out|timeout|closed|failed|unavailable|interrupt|reset|refused|create|start|connect)|(?:timed? out|timeout).*(?:provider|server|bootstrap|browser|webserver|health|daytona|sandbox|ingress|preview|connection|harness))/i;
const PERMANENT =
  /(?:missing (?:credential|fixture secret)|invalid.*(?:credential|api key)|unauthorized|forbidden|qualification|model.*(?:unsupported|incompatible)|artifact.*incompatible|runner_remote_.*(?:incompatible|unavailable)|immutable image digest)/i;
const CANDIDATE =
  /(?:matcher|expected.*observed|marker|issue status|run status|runtime mode|wrong output|missing output)/i;

export function classifyFailure(error: unknown): FailureClass {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (/browser bootstrap failed before task creation/i.test(message))
    return "transient_infrastructure";
  if (/secret.*(?:leak|plaintext|redaction)/i.test(message))
    return "secret_leak";
  if (/cleanup|teardown|lease.*release/i.test(message)) {
    return TRANSIENT.test(message)
      ? "transient_infrastructure"
      : "cleanup_failure";
  }
  if (PERMANENT.test(message)) return "permanent_infrastructure";
  if (TRANSIENT.test(message)) return "transient_infrastructure";
  if (CANDIDATE.test(message)) return "candidate_failure";
  return "candidate_failure";
}

export function shouldRetryFailure(failureClass: FailureClass) {
  return (
    failureClass === "transient_infrastructure" ||
    failureClass === "provider_variance"
  );
}
