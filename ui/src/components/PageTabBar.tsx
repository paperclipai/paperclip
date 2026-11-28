import { isValidElement, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { TabBar, type TabSize } from "./TabBar";
import { useSidebar } from "../context/SidebarContext";

export interface PageTabItem {
  value: string;
  label: ReactNode;
}

interface PageTabBarProps {
  items: readonly PageTabItem[];
  value?: string;
  onValueChange?: (value: string) => void;
  align?: "center" | "start";
  size?: TabSize;
  ariaLabel?: string;
}

function collectReadableText(node: ReactNode, out: string[]) {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    const trimmed = String(node).trim();
    if (trimmed) out.push(trimmed);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectReadableText(child, out);
    }
    return;
  }
  if (isValidElement(node)) {
    const props = node.props as { "aria-hidden"?: boolean | "true" | "false"; children?: ReactNode };
    if (props["aria-hidden"] === true || props["aria-hidden"] === "true") {
      return;
    }
    collectReadableText(props.children, out);
  }
}

export function extractTabOptionText(label: ReactNode, fallback: string): string {
  const parts: string[] = [];
  collectReadableText(label, parts);
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text || fallback;
}

export function PageTabBar({
  items,
  value,
  onValueChange,
  align = "center",
  size = "standard",
  ariaLabel = "Page section",
}: PageTabBarProps) {
  const { isMobile } = useSidebar();

  if (isMobile && value !== undefined && onValueChange) {
    return (
      <div className="relative inline-flex w-fit max-w-full self-start">
        <select
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className="h-9 w-full max-w-full appearance-none rounded-md border border-border bg-background bg-none pl-3 pr-9 py-1 text-base focus:outline-none focus:ring-1 focus:ring-ring"
          aria-label={ariaLabel}
        >
          {items.map((item) => (
            <option key={item.value} value={item.value}>
              {extractTabOptionText(item.label, item.value)}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      </div>
    );
  }

  return (
    <TabBar items={items} size={size} className={align === "start" ? "justify-start" : undefined} />
  );
}
