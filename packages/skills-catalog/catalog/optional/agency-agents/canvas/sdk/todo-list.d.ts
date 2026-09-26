import type { CSSProperties, JSX } from "react";
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export interface TodoItem {
    readonly id: string;
    readonly content: string;
    readonly status: TodoStatus;
}
export type TodoListProps = {
    todos: readonly TodoItem[];
    dimmedTodoIds?: ReadonlySet<string>;
    /** Called when a todo row is clicked (entire row is a button). */
    onTodoClick?: (todo: TodoItem) => void;
    style?: CSSProperties;
};
/**
 * Task list with status icons and wrapping text. Each row is a **clickable**
 * button; use `onTodoClick` to handle selection or navigation.
 *
 * @example
 * ```tsx
 * <TodoList
 *   todos={items}
 *   onTodoClick={(todo) => setActiveId(todo.id)}
 * />
 * ```
 */
export declare function TodoList({ todos, dimmedTodoIds, onTodoClick, style }: TodoListProps): JSX.Element | null;
export type TodoListCardProps = {
    todos: readonly TodoItem[];
    dimmedTodoIds?: ReadonlySet<string>;
    defaultExpanded?: boolean;
    onTodoClick?: (todo: TodoItem) => void;
    style?: CSSProperties;
};
/**
 * Bordered, collapsible todo list with summary header (N of M Done). Compose
 * with `onTodoClick` for row actions.
 *
 * @example
 * ```tsx
 * <TodoListCard
 *   todos={items}
 *   defaultExpanded
 *   onTodoClick={(todo) => console.log(todo.id)}
 * />
 * ```
 */
export declare function TodoListCard({ todos, dimmedTodoIds, defaultExpanded, onTodoClick, style }: TodoListCardProps): JSX.Element | null;
//# sourceMappingURL=todo-list.d.ts.map