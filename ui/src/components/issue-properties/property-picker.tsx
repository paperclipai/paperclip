import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "../../lib/utils";
import { PropertyRow } from "./primitives";

/** Renders a Popover on desktop, or an inline collapsible section on mobile (inline mode). */
export function PropertyPicker({
  inline,
  label,
  open,
  onOpenChange,
  triggerContent,
  triggerClassName,
  popoverClassName,
  popoverAlign = "end",
  extra,
  children,
}: {
  inline?: boolean;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerContent: ReactNode;
  triggerClassName?: string;
  popoverClassName?: string;
  popoverAlign?: "start" | "center" | "end";
  extra?: ReactNode;
  children: ReactNode;
}) {
  const btnCn = cn(
    "inline-flex min-h-5 items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors min-w-0 max-w-full text-left",
    triggerClassName,
  );

  if (inline) {
    return (
      <div>
        <PropertyRow label={label}>
          <button className={btnCn} onClick={() => onOpenChange(!open)}>
            {triggerContent}
          </button>
          {extra}
        </PropertyRow>
        {open && (
          <div className={cn("rounded-md border border-border bg-popover p-1 mb-2", popoverClassName)}>
            {children}
          </div>
        )}
      </div>
    );
  }

  return (
    <PropertyRow label={label}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button className={btnCn}>{triggerContent}</button>
        </PopoverTrigger>
        <PopoverContent className={cn("p-1", popoverClassName)} align={popoverAlign} collisionPadding={16}>
          {children}
        </PopoverContent>
      </Popover>
      {extra}
    </PropertyRow>
  );
}
