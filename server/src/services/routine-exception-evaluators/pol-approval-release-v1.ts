import type {
  RoutineExceptionEvaluationInputV1,
  RoutineExceptionEvaluationResultV1,
} from "@paperclipai/shared";
import type { RoutineExceptionCapabilityBroker } from "../routine-exception-evaluation.js";

export const POL_APPROVAL_RELEASE_CAPABILITIES = [
  "git.fetch:polymarket-bot-main",
  "git.worktree:detached-temp",
  "process.exec:approval-release-pytest",
  "process.exec:approval-release-reconciler",
  "github.read:pull-request",
  "http.get:pol-runtime",
  "paperclip.read:approval-release-links",
] as const;

export async function evaluatePolApprovalReleaseV1(
  input: RoutineExceptionEvaluationInputV1,
  deps: { capabilityBroker: RoutineExceptionCapabilityBroker; signal: AbortSignal },
): Promise<RoutineExceptionEvaluationResultV1> {
  const fetched = await deps.capabilityBroker.invoke("git.fetch:polymarket-bot-main", {
    repositoryId: "thedelph/polymarket-bot",
    ref: "refs/heads/main",
  }, deps.signal);
  const worktree = await deps.capabilityBroker.invoke("git.worktree:detached-temp", { fetched }, deps.signal);
  const tests = await deps.capabilityBroker.invoke("process.exec:approval-release-pytest", { worktree }, deps.signal);
  const pullRequest = await deps.capabilityBroker.invoke("github.read:pull-request", {
    typedConfig: input.binding.typedConfig,
  }, deps.signal);
  const runtime = await deps.capabilityBroker.invoke("http.get:pol-runtime", {
    routeIds: ["runtime-summary", "status", "reconciliation"],
  }, deps.signal);
  const links = await deps.capabilityBroker.invoke("paperclip.read:approval-release-links", {
    typedConfig: input.binding.typedConfig,
  }, deps.signal);
  const result = await deps.capabilityBroker.invoke("process.exec:approval-release-reconciler", {
    schemaVersion: 1,
    fetched,
    worktree,
    tests,
    pullRequest,
    runtime,
    links,
    openExceptions: input.openExceptions,
    aborted: deps.signal.aborted,
  }, deps.signal);
  return result as RoutineExceptionEvaluationResultV1;
}
