export function ChatLoadingSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-card p-3 animate-pulse space-y-2">
      <div className="h-3 w-24 rounded bg-muted" />
      <div className="h-8 w-full rounded bg-muted" />
      <div className="h-3 w-32 rounded bg-muted" />
    </div>
  );
}
