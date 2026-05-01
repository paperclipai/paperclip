import type { ReactNode } from "react";
import { SidebarInfoButton } from "./SidebarInfoButton";

interface SidebarSectionProps {
  label: string;
  children: ReactNode;
  info?: string;
}

export function SidebarSection({ label, children, info }: SidebarSectionProps) {
  return (
    <div>
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <div className="text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60">
          {label}
        </div>
        {info && <SidebarInfoButton title={label} info={info} alwaysVisible />}
      </div>
      <div className="flex flex-col gap-0.5 mt-0.5">{children}</div>
    </div>
  );
}
