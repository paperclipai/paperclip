import type { CanvasPalette, CanvasTokens } from "./canvas-tokens.js";
import { type CanvasAction } from "./internal/canvas-action-dispatch.js";
/**
 * Host theme for the current canvas. Semantic color groups (`text`, `bg`,
 * `fill`, `stroke`, `accent`, `diff`) live at the top level for ergonomic
 * inline-style access; `tokens` is also present as a self-reference for
 * callers that prefer a namespaced form.
 */
export interface CanvasHostTheme extends CanvasTokens {
    readonly kind: string;
    readonly tokens: CanvasTokens;
    readonly palette: CanvasPalette;
}
/**
 * Returns the current host theme. Falls back to dark mode when no host
 * state is available.
 *
 * Semantic color groups are available directly on the returned object —
 * `accent`, `text`, `bg`, `fill`, `stroke`, `diff` — as well as `kind`
 * (`"dark"` | `"light"` | …) and `palette` (the flat color palette).
 *
 * Call `useHostTheme()` inside each component that needs theme access —
 * the returned object is scoped to that component, not shared across
 * function boundaries.
 *
 * Stable paths for `style={{ ... }}` usage:
 * - `text.primary / secondary / tertiary / quaternary` — text hierarchy
 * - `bg.editor / chrome / elevated` — surface backgrounds
 * - `fill.primary / secondary / tertiary / quaternary` — tinted fills
 * - `stroke.primary / secondary / tertiary` — borders and dividers
 * - `accent.primary / control` — accent blue and button background
 * - `text.link` — link color
 * - `text.onAccent` — text on accent-colored surfaces
 *
 * Prefer built-in components (`Card`, `Button`, `Text`, etc.) over raw
 * token usage. Reach for tokens only when no component covers the case,
 * and stick to flat solid colors — no gradients, no box-shadows.
 *
 * @example
 * ```tsx
 * function Overview() {
 *   const theme = useHostTheme();
 *   return (
 *     <div style={{ background: theme.fill.tertiary, color: theme.text.secondary, padding: 8 }}>
 *       <span style={{ color: theme.accent.primary }}>Accent text</span>
 *     </div>
 *   );
 * }
 * ```
 */
export declare function useHostTheme(): CanvasHostTheme;
/**
 * Setter for `useCanvasState`. Accepts either a new value or an updater
 * function that receives the previous value.
 */
export type SetCanvasState<T> = (action: T | ((prev: T) => T)) => void;
/**
 * Persistent state hook for canvas applications. Works like `React.useState`
 * but the value survives rebuilds, reloads, and IDE restarts — it is stored
 * in a `.canvas.data.json` sidecar file next to the canvas source.
 *
 * Each key is a unique string chosen by the canvas author. Keys are stable
 * regardless of hook call order or component tree structure.
 *
 * @param key - Unique string identifier for this piece of state.
 * @param defaultValue - Value returned when no persisted value exists for `key`.
 * @returns A `[value, setValue]` tuple, same shape as `React.useState`.
 *
 * @example
 * ```tsx
 * function Counter() {
 *   const [count, setCount] = useCanvasState("count", 0);
 *   return <Button onClick={() => setCount(c => c + 1)}>{count}</Button>;
 * }
 * ```
 *
 * @example
 * ```tsx
 * interface Column { id: string; title: string; cardIds: string[] }
 * function KanbanBoard() {
 *   const [columns, setColumns] = useCanvasState<Column[]>("columns", [
 *     { id: "todo", title: "To Do", cardIds: [] },
 *     { id: "doing", title: "In Progress", cardIds: [] },
 *     { id: "done", title: "Done", cardIds: [] },
 *   ]);
 *   // ...
 * }
 * ```
 */
export declare function useCanvasState<T>(key: string, defaultValue: T): [T, SetCanvasState<T>];
export type { CanvasAction };
/**
 * Returns a stable `dispatch` function for triggering IDE actions from
 * canvas buttons. Actions are fire-and-forget — the canvas does not
 * receive a response.
 *
 * ## Available actions
 *
 * **`openAgent`** — Navigate the IDE to an agent conversation.
 * `agentId` is the conversation UUID (the filename stem from the
 * `agent-transcripts/` directory). Works for both local and
 * cloud/background agents in Glass and classic IDE modes.
 *
 * **`newComposerChat`** — Open a new local agent chat with the
 * dispatching canvas file as an @mention. Optional `userPrompt` is
 * appended after the mention. The canvas file is resolved from the
 * action route's `canvasId`; do not pass the path from canvas UI.
 *
 * **`openFile`** — Open an existing workspace file in the host IDE.
 * `path` may be workspace-relative or absolute. Optional `selection`
 * follows VS Code editor line/column fields.
 *
 * @example
 * ```tsx
 * function AgentLink({ agentId, title }: { agentId: string; title: string }) {
 *   const dispatch = useCanvasAction();
 *   return (
 *     <Button onClick={() => dispatch({ type: "openAgent", agentId })}>
 *       {title}
 *     </Button>
 *   );
 * }
 * ```
 *
 * @example
 * ```tsx
 * function AskAboutCanvas() {
 *   const dispatch = useCanvasAction();
 *   return (
 *     <Button
 *       onClick={() =>
 *         dispatch({
 *           type: "newComposerChat",
 *           userPrompt: "please explain what is using the most context",
 *         })
 *       }
 *     >
 *       Ask in chat
 *     </Button>
 *   );
 * }
 * ```
 */
export declare function useCanvasAction(): (action: CanvasAction) => void;
//# sourceMappingURL=hooks.d.ts.map