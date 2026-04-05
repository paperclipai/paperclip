import type {
  PluginDataResult,
  PluginActionFn,
  PluginHostContext,
  PluginStreamResult,
  PluginToastFn,
} from "./types.js";
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
 *   if (loading) return <div>Loading…</div>;
 *   if (error) return <div>Error: {error.message}</div>;
 *   return <div>Synced Issues: {data!.syncedCount}</div>;
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

// ---------------------------------------------------------------------------
// usePluginStream
// ---------------------------------------------------------------------------

/**
 * Subscribe to a real-time event stream pushed from the plugin worker.
 *
 * Opens an SSE connection to `GET /api/plugins/:pluginId/bridge/stream/:channel`
 * and accumulates events as they arrive. The worker pushes events using
 * `ctx.streams.emit(channel, event)`.
 *
 * @template T The expected shape of each streamed event
 * @param channel - The stream channel name (must match what the worker uses in `ctx.streams.emit`)
 * @param options - Optional configuration for the stream
 * @returns `PluginStreamResult<T>` with `events`, `lastEvent`, connection status, and `close()`
 *
 * @example
 * ```tsx
 * function ChatMessages() {
 *   const { events, connected, close } = usePluginStream<ChatToken>("chat-stream");
 *
 *   return (
 *     <div>
 *       {events.map((e, i) => <span key={i}>{e.text}</span>)}
 *       {connected && <span className="pulse" />}
 *       <button onClick={close}>Stop</button>
 *     </div>
 *   );
 * }
 * ```
 *
 * @see PLUGIN_SPEC.md §19.8 — Real-Time Streaming
 */
export function usePluginStream<T = unknown>(
  channel: string,
  options?: { companyId?: string },
): PluginStreamResult<T> {
  const impl = getSdkUiRuntimeValue<
    (nextChannel: string, nextOptions?: { companyId?: string }) => PluginStreamResult<T>
  >("usePluginStream");
  return impl(channel, options);
}

// ---------------------------------------------------------------------------
// usePluginToast
// ---------------------------------------------------------------------------

/**
 * Trigger a host toast notification from plugin UI.
 *
 * This lets plugin pages and widgets surface user-facing feedback through the
 * same toast system as the host app without reaching into host internals.
 */
export function usePluginToast(): PluginToastFn {
  const impl = getSdkUiRuntimeValue<() => PluginToastFn>("usePluginToast");
  return impl();
}
