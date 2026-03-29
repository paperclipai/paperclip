import { type ReactNode, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "../lib/utils";

interface SidebarSectionProps {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}

export function SidebarSection({ label, children, defaultOpen = true }: SidebarSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <CollapsibleTrigger className="flex items-center w-full px-3 py-1.5">
          <ChevronRight
            className={cn(
              "h-3 w-3 text-muted-foreground/60 transition-transform opacity-0 group-hover:opacity-100",
              open && "rotate-90"
            )}
          />
          <span className="ml-1 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60" style={{ fontFamily: "var(--font-family-display)" }}>
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
