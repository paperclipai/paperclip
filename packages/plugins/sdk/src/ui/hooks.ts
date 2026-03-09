import type { PluginDataResult, PluginActionFn, PluginHostContext } from "./types.js";
import { getSdkUiRuntimeValue } from "./runtime.js";

// ---------------------------------------------------------------------------
// usePluginData
// ---------------------------------------------------------------------------

/**
 * Fetch data from the plugin worker's registered `getData` handler.
 *
 * Calls `ctx.data.register(key, handler)` in the worker and returns the
 * result as reactive state. Re-fetches when `params` changes.
 *
 * @template T The expected shape of the returned data
 * @param key - The data key matching the handler registered with `ctx.data.register()`
 * @param params - Optional parameters forwarded to the handler
 * @returns `PluginDataResult<T>` with `data`, `loading`, `error`, and `refresh`
 *
 * @example
 * ```tsx
 * function SyncWidget({ context }: PluginWidgetProps) {
 *   const { data, loading, error } = usePluginData<SyncHealth>("sync-health", {
 *     companyId: context.companyId,
 *   });
 *
 *   if (loading) return <Spinner />;
 *   if (error) return <div>Error: {error.message}</div>;
 *   return <MetricCard label="Synced Issues" value={data!.syncedCount} />;
 * }
 * ```
 *
 * @see PLUGIN_SPEC.md §13.8 — `getData`
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */
export function usePluginData<T = unknown>(
  key: string,
  params?: Record<string, unknown>,
): PluginDataResult<T> {
  const impl = getSdkUiRuntimeValue<
    (nextKey: string, nextParams?: Record<string, unknown>) => PluginDataResult<T>
  >("usePluginData");
  return impl(key, params);
}

// ---------------------------------------------------------------------------
// usePluginAction
// ---------------------------------------------------------------------------

/**
 * Get a callable function that invokes the plugin worker's registered
 * `performAction` handler.
 *
 * The returned function is async and throws a `PluginBridgeError` on failure.
 *
 * @param key - The action key matching the handler registered with `ctx.actions.register()`
 * @returns An async function that sends the action to the worker and resolves with the result
 *
 * @example
 * ```tsx
 * function ResyncButton({ context }: PluginWidgetProps) {
 *   const resync = usePluginAction("resync");
 *   const [error, setError] = useState<string | null>(null);
 *
 *   async function handleClick() {
 *     try {
 *       await resync({ companyId: context.companyId });
 *     } catch (err) {
 *       setError((err as PluginBridgeError).message);
 *     }
 *   }
 *
 *   return <button onClick={handleClick}>Resync Now</button>;
 * }
 * ```
 *
 * @see PLUGIN_SPEC.md §13.9 — `performAction`
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */
export function usePluginAction(key: string): PluginActionFn {
  const impl = getSdkUiRuntimeValue<(nextKey: string) => PluginActionFn>("usePluginAction");
  return impl(key);
}

// ---------------------------------------------------------------------------
// useHostContext
// ---------------------------------------------------------------------------

/**
 * Read the current host context (active company, project, entity, user).
 *
 * Use this to know which context the plugin component is being rendered in
 * so you can scope data requests and actions accordingly.
 *
 * @returns The current `PluginHostContext`
 *
 * @example
 * ```tsx
 * function IssueTab() {
 *   const { companyId, entityId } = useHostContext();
 *   const { data } = usePluginData("linear-link", { issueId: entityId });
 *   return <div>{data?.linearIssueUrl}</div>;
 * }
 * ```
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 */
export function useHostContext(): PluginHostContext {
  const impl = getSdkUiRuntimeValue<() => PluginHostContext>("useHostContext");
  return impl();
}
