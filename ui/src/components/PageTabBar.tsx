import type { ReactNode } from "react";
import { useSidebar } from "../context/SidebarContext";

export interface PageTabItem {
  value: string;
  label: ReactNode;
}

interface PageTabBarProps {
  items: PageTabItem[];
  value?: string;
  onValueChange?: (value: string) => void;
  align?: "center" | "start";
}

export function PageTabBar({ items, value, onValueChange, align = "center" }: PageTabBarProps) {
  const { isMobile } = useSidebar();

  if (isMobile && value !== undefined && onValueChange) {
    return (
      <select
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        className="h-9 rounded-md border border-border bg-background px-2 py-1 text-base focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {items.map((item) => (
          <option key={item.value} value={item.value}>
            {typeof item.label === "string" ? item.label : item.value}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div
      className={`flex items-center border-b border-border ${align === "start" ? "justify-start" : "justify-center"}`}
      role="tablist"
    >
      {items.map((item) => (
        <button
          key={item.value}
          role="tab"
          aria-selected={value === item.value}
          onClick={() => onValueChange?.(item.value)}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
            value === item.value
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
