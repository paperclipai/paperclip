import type { SurfaceData } from "../../kit";

export function LandingBody({ items }: SurfaceData["landing"]) {
  return (
    <div data-lab-stub="today-landing" className="flex flex-col gap-2 rounded-md border border-dashed border-border p-3 text-sm">
      <p className="font-mono text-(length:--text-micro) uppercase tracking-(--tracking-label) text-muted-foreground">
        Today · Landing · mount the shipped Needs You component here
      </p>
      <ul className="flex list-none flex-col gap-1 p-0">
        {items.map((item) => (
          <li key={item.id} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-foreground">{item.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {item.author} · {item.updatedLabel}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
