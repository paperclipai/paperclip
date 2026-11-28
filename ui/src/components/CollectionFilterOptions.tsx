import { useId, type ReactNode } from "react";
import { Filter, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { FlyoutAppearanceProvider, FlyoutHeader } from "./ui/flyout";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { TruncatedText } from "./TruncatedText";

export function ToolbarFilterPopover({
  activeCount,
  onClear,
  label = "Filter",
  contentLabel = "Filters",
  align = "end",
  contentClassName,
  triggerDataAttr,
  children,
}: {
  activeCount: number;
  onClear?: () => void;
  label?: string;
  contentLabel?: string;
  align?: "start" | "center" | "end";
  contentClassName?: string;
  triggerDataAttr?: string;
  children: ReactNode;
}) {
  const active = activeCount > 0;
  return (
    <FlyoutAppearanceProvider appearance="refreshed">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="design-toolbar-button design-toolbar-icon relative"
            title={active ? `Filters: ${activeCount}` : "Filter"}
            aria-label={active ? `${label} (${activeCount})` : label}
            data-active={active}
            {...(triggerDataAttr ? { [triggerDataAttr]: "" } : {})}
          >
            <Filter aria-hidden="true" />
            {active ? (
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-primary text-(length:--text-nano) font-semibold text-primary-foreground"
              >
                {activeCount}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align={align} className={cn("p-0", contentClassName)} aria-label={contentLabel}>
          <FlyoutHeader className="flex items-center justify-between">
            <span>Filters</span>
            {active && onClear ? (
              <Button type="button" variant="ghost" size="xs" onClick={onClear}>
                Clear
              </Button>
            ) : null}
          </FlyoutHeader>
          {children}
        </PopoverContent>
      </Popover>
    </FlyoutAppearanceProvider>
  );
}

export function FilterGroup({ title, searchLabel, query, onQueryChange, children, optionsKey }: { title: string; searchLabel?: string; query?: string; onQueryChange?: (value: string) => void; children: ReactNode; optionsKey: string }) {
  const headingId = useId();
  return (
    <section className="task-filter-group" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      <div className="task-filter-group-body">
        {searchLabel ? <div className="task-filter-search"><Search aria-hidden /><Input aria-label={`Search ${searchLabel}`} placeholder={`Search ${searchLabel}...`} value={query} onChange={event => onQueryChange?.(event.target.value)} /></div> : null}
        <div className="task-filter-options" data-filter-options={optionsKey}>{children}</div>
      </div>
    </section>
  );
}

export function FilterRow({ label, checked, onToggle, icon }: { label: string; checked: boolean; onToggle: () => void; icon?: ReactNode }) {
  return <label className="task-filter-option" data-marquee-surface><Checkbox aria-label={label} checked={checked} onCheckedChange={onToggle} />{icon ? <span className="task-filter-icon" aria-hidden>{icon}</span> : null}<TruncatedText className="task-filter-option-label">{label}</TruncatedText></label>;
}
