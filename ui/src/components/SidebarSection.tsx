import type { ReactNode } from "react";

interface SidebarSectionProps {
  label: string;
  children: ReactNode;
}

export function SidebarSection({ label, children }: SidebarSectionProps) {
  return (
    <div className="space-y-2">
      <div className="paperclip-section-header px-1">
        <span className="paperclip-kicker">{label}</span>
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}
