import { type ReactNode, useState, useCallback } from "react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "../lib/utils";

const STORAGE_KEY = "ironworks.sidebarSections";

function readCollapsedState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeCollapsedState(state: Record<string, boolean>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

interface SidebarSectionProps {
  label: string;
  children: ReactNode;
}

export function SidebarSection({ label, children }: SidebarSectionProps) {
  const [open, setOpen] = useState(() => {
    const state = readCollapsedState();
    // Default to open (true) if no stored preference
    return state[label] !== false;
  });

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      const state = readCollapsedState();
      state[label] = nextOpen;
      writeCollapsedState(state);
    },
    [label],
  );

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <div className="group">
        <CollapsibleTrigger className="flex items-center w-full px-3 py-1.5">
          <ChevronRight
            className={cn(
              "h-3 w-3 text-muted-foreground/50 transition-transform shrink-0",
              open && "rotate-90",
            )}
          />
          <span className="ml-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/60">
            {label}
          </span>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="flex flex-col gap-0.5 mt-0.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
