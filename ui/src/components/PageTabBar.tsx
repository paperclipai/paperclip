import type { ReactNode } from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSidebar } from "../context/SidebarContext";

export interface PageTabItem {
  value: string;
  label: ReactNode;
}

interface PageTabBarProps {
  items: PageTabItem[];
  value?: string;
  onValueChange?: (value: string) => void;
}

export function PageTabBar({ items, value, onValueChange }: PageTabBarProps) {
  const { isMobile } = useSidebar();

  if (isMobile && value !== undefined && onValueChange) {
    return (
      <select
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        className="paperclip-panel paperclip-nav-meta h-10 rounded-full px-4 py-1 text-[0.7rem] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
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
    <TabsList variant="line" className="paperclip-chip rounded-full p-1">
      {items.map((item) => (
        <TabsTrigger
          key={item.value}
          value={item.value}
          className="paperclip-nav-meta rounded-full px-3 text-[0.68rem] text-muted-foreground data-[state=active]:border-primary/20 data-[state=active]:bg-primary/10 data-[state=active]:text-foreground data-[state=active]:shadow-none"
        >
          {item.label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
