# Paperclip Plugin UI SDK Reference

This document describes the hooks, types, and shared components available to plugin UI bundles.

## Bridge Hooks

Import these from `@paperclipai/plugin-sdk/ui`.

### `usePluginData<T>(key, params?)`

Fetch data from the plugin worker's registered `getData` handler.
Calls `ctx.data.register(key, handler)` in the worker.

```tsx
const { data, loading, error, refresh } = usePluginData<MyDataType>("my-data-key", {
  id: "123"
});
```

### `usePluginAction(key)`

Returns an async function that invokes the plugin worker's registered `performAction` handler.
Calls `ctx.actions.register(key, handler)` in the worker.

```tsx
const myAction = usePluginAction("my-action-key");

const handleAction = async () => {
  try {
    const result = await myAction({ foo: "bar" });
    // handle success
  } catch (err) {
    // err is a PluginBridgeError
  }
};
```

### `useHostContext()`

Read the current host context (active company, project, entity, user).

```tsx
const { companyId, projectId, entityId, entityType, userId } = useHostContext();
```

---

## Shared Components

These components are provided by the host at runtime and match the Paperclip design system.
Import them from `@paperclipai/plugin-sdk/ui`.

### `MetricCard`
Displays a single metric with an optional trend indicator and sparkline.

```tsx
<MetricCard
  label="Synced Issues"
  value={42}
  trend={{ direction: "up", percentage: 12 }}
/>
```

### `StatusBadge`
Displays an inline status badge (`ok` / `warning` / `error` / `info` / `pending`).

```tsx
<StatusBadge label="Running" status="ok" />
```

### `DataTable`
Sortable, paginated data table.

```tsx
<DataTable
  columns={[
    { key: "id", header: "ID", width: "100px" },
    { key: "title", header: "Title" },
    { key: "status", header: "Status", render: (v) => <StatusBadge label={v} status="info" /> }
  ]}
  rows={data.items}
/>
```

### `Spinner`
Loading indicator.

```tsx
<Spinner size="md" />
```

### `ErrorBoundary`
React error boundary to prevent plugin rendering errors from crashing the host page.
**Always wrap your main slot component in this.**

```tsx
<ErrorBoundary>
  <MyPluginComponent />
</ErrorBoundary>
```

---

## Types

### `PluginHostContext`
```ts
interface PluginHostContext {
  companyId: string | null;
  companyPrefix: string | null;
  projectId: string | null;
  entityId: string | null;
  entityType: string | null;
  userId: string | null;
}
```

### `PluginBridgeError`
```ts
interface PluginBridgeError {
  code: "WORKER_UNAVAILABLE" | "CAPABILITY_DENIED" | "WORKER_ERROR" | "TIMEOUT" | "UNKNOWN";
  message: string;
  details?: unknown;
}
```
