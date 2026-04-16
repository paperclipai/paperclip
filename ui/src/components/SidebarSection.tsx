import type { ReactNode } from "react";
import { useSidebar } from "../context/SidebarContext";

interface SidebarSectionProps {
  label: string;
  children: ReactNode;
}

export function SidebarSection({ label, children }: SidebarSectionProps) {
  const { collapsed } = useSidebar();

  return (
    <div>
      {!collapsed && (
        <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60">
          {label}
        </div>
      )}
      {collapsed && <div className="my-1 mx-2 h-px bg-border" />}
      <div className="flex flex-col gap-0.5 mt-0.5">{children}</div>
    </div>
  );
}
