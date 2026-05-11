import type { ReactNode } from "react";

interface SidebarSectionProps {
  label: string;
  children: ReactNode;
}

export function SidebarSection({ label, children }: SidebarSectionProps) {
  return (
    <div className="space-y-2">
      <div className="px-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground/70">
        {label}
      </div>
      <div className="mt-0.5 flex flex-col gap-1">{children}</div>
    </div>
  );
}
