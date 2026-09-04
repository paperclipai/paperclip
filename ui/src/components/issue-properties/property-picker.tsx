import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";
import { useStreamlinedUiEnabled } from "../../hooks/useStreamlinedUiEnabled";
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
  stacked = false,
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
  /** Top-aligns the row and vertically stacks chip collections in the trigger. */
  stacked?: boolean;
  children: ReactNode;
}) {
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const btnCn = cn(
    "inline-flex min-h-5 items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors min-w-0 max-w-full text-left",
    streamlinedUiEnabled && "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    triggerClassName,
  );

  if (inline) {
    return (
      <div>
        <PropertyRow label={label} wrap={stacked}>
          <button className={cn(btnCn, stacked && "items-start")} onClick={() => onOpenChange(!open)} aria-expanded={streamlinedUiEnabled ? open : undefined}>
            {triggerContent}
            {streamlinedUiEnabled ? (
              <ChevronDown className={cn("ml-auto h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
            ) : null}
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
    <PropertyRow label={label} wrap={stacked}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button className={cn(btnCn, stacked && "items-start")} aria-expanded={streamlinedUiEnabled ? open : undefined}>
            {triggerContent}
            {streamlinedUiEnabled ? (
              <ChevronDown className={cn("ml-auto h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent className={cn("p-1", popoverClassName)} align={popoverAlign} collisionPadding={16}>
          {children}
        </PopoverContent>
      </Popover>
      {extra}
    </PropertyRow>
  );
}
