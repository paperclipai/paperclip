export function PageSkeleton() {
  return (
    <div className="space-y-4 p-8">
      <div className="h-6 w-48 rounded animate-pulse" style={{ background: "var(--skeleton)" }} />
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 rounded-lg animate-pulse" style={{ background: "var(--skeleton)" }} />
        ))}
      </div>
    </div>
  );
}
