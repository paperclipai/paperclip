import { type ReactNode, useMemo, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface FilterMenuOption {
  value: string;
  label: string;
  count?: number;
  icon?: ReactNode;
  swatch?: string;
  searchText?: string;
}

export interface FilterMenuPreset {
  label: string;
  values: string[];
}

interface BaseProps {
  label: string;
  options: FilterMenuOption[];
  /** Values currently selected. */
  selected: string[];
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyMessage?: string;
  triggerClassName?: string;
  contentClassName?: string;
  align?: "start" | "end";
}

interface MultiProps extends BaseProps {
  multi: true;
  onToggle: (value: string) => void;
  onClear: () => void;
  presets?: FilterMenuPreset[];
}

interface SingleProps extends BaseProps {
  multi?: false;
  onSelect: (value: string | undefined) => void;
}

export type SearchFilterMenuProps = MultiProps | SingleProps;

function summarizeTrigger(label: string, selected: string[], options: FilterMenuOption[]): string {
  if (selected.length === 0) return label;
  if (selected.length === 1) {
    const only = options.find((option) => option.value === selected[0]);
    return only ? `${label}: ${only.label}` : label;
  }
  return `${label}: ${selected.length}`;
}

export function SearchFilterMenu(props: SearchFilterMenuProps) {
  const {
    label,
    options,
    selected,
    searchable = false,
    searchPlaceholder = "Search…",
    emptyMessage = "No options",
    triggerClassName,
    contentClassName,
    align = "start",
  } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const normalized = query.trim().toLowerCase();
  const visibleOptions = useMemo(() => {
    if (!normalized) return options;
    return options.filter((option) =>
      `${option.label} ${option.searchText ?? ""}`.toLowerCase().includes(normalized),
    );
  }, [normalized, options]);

  const active = selected.length > 0;

  function handleOptionClick(value: string) {
    if (props.multi) {
      props.onToggle(value);
      return;
    }
    // Single-select: clicking the selected value clears it, otherwise selects.
    props.onSelect(selected.includes(value) ? undefined : value);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-8 gap-1 text-xs font-normal",
            active && "border-primary/60 text-foreground",
            triggerClassName,
          )}
          aria-label={`Filter by ${label}`}
        >
          <span className="truncate">{summarizeTrigger(label, selected, options)}</span>
          {active ? (
            <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-(length:--text-nano) font-semibold tabular-nums text-primary-foreground">
              {selected.length}
            </span>
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className={cn("w-64 p-0", contentClassName)}>
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          {props.multi && active ? (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => props.onClear()}
            >
              Clear
            </button>
          ) : null}
        </div>

        {props.multi && props.presets && props.presets.length > 0 ? (
          <div className="flex flex-wrap gap-1 px-3 pb-2">
            {props.presets.map((preset) => {
              const isActive =
                preset.values.length === selected.length &&
                preset.values.every((value) => selected.includes(value));
              return (
                <button
                  key={preset.label}
                  type="button"
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-(length:--text-micro) transition-colors",
                    isActive
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                  )}
                  onClick={() => {
                    // Replace selection with the preset (toggle off when already exact).
                    for (const value of options.map((option) => option.value)) {
                      const wantSelected = !isActive && preset.values.includes(value);
                      const currentlySelected = selected.includes(value);
                      if (wantSelected !== currentlySelected) props.onToggle(value);
                    }
                  }}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        ) : null}

        {searchable ? (
          <div className="px-3 pb-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                className="h-8 pl-7 text-xs"
              />
            </div>
          </div>
        ) : null}

        <div className="max-h-72 overflow-y-auto overscroll-contain border-t border-border py-1">
          {visibleOptions.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">{emptyMessage}</div>
          ) : (
            visibleOptions.map((option) => {
              const isSelected = selected.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/50"
                  onClick={() => handleOptionClick(option.value)}
                >
                  {props.multi ? (
                    <Checkbox checked={isSelected} tabIndex={-1} className="pointer-events-none" />
                  ) : (
                    <span className="flex h-4 w-4 items-center justify-center">
                      {isSelected ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                    </span>
                  )}
                  {option.icon ? <span className="flex h-4 w-4 items-center justify-center">{option.icon}</span> : null}
                  {option.swatch ? (
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: option.swatch }}
                      aria-hidden
                    />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-sm">{option.label}</span>
                  {typeof option.count === "number" ? (
                    <span className="ml-1 text-xs tabular-nums text-muted-foreground">{option.count}</span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
