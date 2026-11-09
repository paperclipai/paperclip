import type { ReactNode } from "react";
import { ToggleGroup } from "radix-ui";
import { TabsList, TabsTrigger } from "./ui/tabs";
import { cn } from "@/lib/utils";

export type TabSize = "compact" | "standard";
export interface TabBarItem<T extends string = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}
interface TabBarProps {
  items: readonly TabBarItem[];
  size?: TabSize;
  label?: string;
  className?: string;
}

/** Canonical content tabs. Compose inside Tabs with matching TabsContent panels. */
export function TabBar({ items, size = "standard", label, className }: TabBarProps) {
  return <TabsList variant="line" data-canonical-tabs={size} aria-label={label} className={cn("canonical-tab-list", className)}>
    {items.map(item => <TabsTrigger key={item.value} value={item.value} disabled={item.disabled} className="canonical-tab">{item.label}</TabsTrigger>)}
  </TabsList>;
}

/** Same two visual sizes for collection filters; radio choices are not panels. */
export function TabFilters<T extends string>({ items, value, onValueChange, size = "standard", label, className }: {
  items: readonly TabBarItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
  size?: TabSize;
  label: string;
  className?: string;
}) {
  return <ToggleGroup.Root type="single" value={value} onValueChange={next => { if (next) onValueChange(next as T); }} data-canonical-tabs={size} aria-label={label} className={cn("canonical-tab-list", className)}>
    {items.map(item => <ToggleGroup.Item key={item.value} value={item.value} disabled={item.disabled} className="canonical-tab">{item.label}</ToggleGroup.Item>)}
  </ToggleGroup.Root>;
}
