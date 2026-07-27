import type {
  RoutineExceptionEvaluationInputV1,
  RoutineExceptionEvaluationResultV1,
} from "@paperclipai/shared";
import type { RoutineExceptionCapabilityBroker } from "../routine-exception-evaluation.js";

export const POL_RUNTIME_SOURCE_OF_TRUTH_CAPABILITIES = [
  "http.get:pol-runtime",
  "service-config.read:pol-runtime-binding",
  "sqlite.readonly:pol-runtime-db",
  "process.exec:runtime-watchdog-classifier",
] as const;

export async function evaluatePolRuntimeSourceOfTruthV1(
  input: RoutineExceptionEvaluationInputV1,
  deps: { capabilityBroker: RoutineExceptionCapabilityBroker; signal: AbortSignal },
): Promise<RoutineExceptionEvaluationResultV1> {
  const binding = await deps.capabilityBroker.invoke("service-config.read:pol-runtime-binding", {
    companyId: input.run.companyId,
    routineId: input.run.routineId,
  }, deps.signal);
  const runtime = await deps.capabilityBroker.invoke("http.get:pol-runtime", {
    routeIds: ["runtime-summary", "status", "reconciliation", "portfolio", "profitability", "readiness"],
  }, deps.signal);
  const database = await deps.capabilityBroker.invoke("sqlite.readonly:pol-runtime-db", {
    binding,
    queryIds: ["heartbeat", "positions", "predictions", "orders", "reconciliation"],
  }, deps.signal);
  const result = await deps.capabilityBroker.invoke("process.exec:runtime-watchdog-classifier", {
    schemaVersion: 1,
    runtime,
    database,
    openExceptions: input.openExceptions,
    typedConfig: input.binding.typedConfig,
    aborted: deps.signal.aborted,
  }, deps.signal);
  return result as RoutineExceptionEvaluationResultV1;
}
