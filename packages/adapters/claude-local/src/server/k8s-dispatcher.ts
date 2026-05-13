import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import type { AdapterKubernetesExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

/**
 * Dispatcher signature: given an AdapterExecutionContext whose
 * `executionTarget.kind === "kubernetes"` and the resolved target itself,
 * run the agent in the cluster and return an AdapterExecutionResult.
 *
 * Registered at server startup (see server/src/adapters/execution-targets/kubernetes.ts);
 * adapters call `getKubernetesExecutionDispatcher()` to look it up. When the
 * dispatcher is missing (test environments, CLI-only flows) the adapter falls
 * back to the M1 NOT_YET_SUPPORTED rejection so callers still see a structured
 * response instead of a crash.
 */
export type KubernetesExecutionDispatcher = (input: {
  ctx: AdapterExecutionContext;
  target: AdapterKubernetesExecutionTarget;
}) => Promise<AdapterExecutionResult>;

let registered: KubernetesExecutionDispatcher | null = null;

/**
 * Install the dispatcher. The server calls this exactly once at startup with
 * a closure that walks through the execution-target registry and invokes the
 * kubernetes driver's run() method.
 */
export function setKubernetesExecutionDispatcher(dispatcher: KubernetesExecutionDispatcher | null): void {
  registered = dispatcher;
}

export function getKubernetesExecutionDispatcher(): KubernetesExecutionDispatcher | null {
  return registered;
}
