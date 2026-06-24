import { Check, ChevronsUpDown } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fuzzyTextMatchesQuery } from "@/lib/searchable-select";
import { cn } from "@/lib/utils";

export interface SearchableSelectOption<TValue extends string = string> {
  key: string;
  value: TValue;
  label: string;
  searchText?: string;
  disabled?: boolean;
}

export interface SearchableSelectGroup<TValue extends string = string, TOption extends SearchableSelectOption<TValue> = SearchableSelectOption<TValue>> {
  id: string;
  label?: string;
  options: readonly TOption[];
}

interface SearchableSelectRenderState {
  selected: boolean;
}

export interface SearchableSelectProps<
  TValue extends string = string,
  TOption extends SearchableSelectOption<TValue> = SearchableSelectOption<TValue>,
> {
  value: TValue | "";
  groups: readonly SearchableSelectGroup<TValue, TOption>[];
  onValueChange: (value: TValue, option: TOption) => void;
  placeholder: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  loadingMessage?: string;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  align?: "start" | "center" | "end";
  contentWidth?: "trigger" | "auto";
  renderValue?: (option: TOption | null) => ReactNode;
  renderOption?: (option: TOption, state: SearchableSelectRenderState) => ReactNode;
  filterOption?: (option: TOption, query: string) => boolean;
  disablePortal?: boolean;
}

function defaultFilterOption(option: SearchableSelectOption, query: string) {
  return fuzzyTextMatchesQuery(`${option.label} ${option.searchText ?? ""}`, query);
}

export function SearchableSelect<
  TValue extends string = string,
  TOption extends SearchableSelectOption<TValue> = SearchableSelectOption<TValue>,
>({
  value,
  groups,
  onValueChange,
  placeholder,
  searchPlaceholder = "Search...",
  emptyMessage = "No options found.",
  loadingMessage = "Loading...",
  loading = false,
  disabled = false,
  className,
  triggerClassName,
  contentClassName,
  align = "start",
  contentWidth = "trigger",
  renderValue,
  renderOption,
  filterOption = defaultFilterOption,
  disablePortal,
}: SearchableSelectProps<TValue, TOption>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const pointerFocusRef = useRef(false);

  const selectedOption = useMemo(() => {
    for (const group of groups) {
      const option = group.options.find((candidate) => candidate.value === value);
      if (option) return option;
    }
    return null;
  }, [groups, value]);

  const filteredGroups = useMemo(() => {
    if (loading) return [];
    return groups
      .map((group) => ({
        ...group,
        options: group.options.filter((option) => filterOption(option, query)),
      }))
      .filter((group) => group.options.length > 0);
  }, [filterOption, groups, loading, query]);

  const hasOptions = filteredGroups.some((group) => group.options.length > 0);

  function selectOption(option: TOption) {
    if (option.disabled) return;
    onValueChange(option.value, option);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onPointerDown={() => {
            pointerFocusRef.current = true;
          }}
          onFocus={() => {
            if (pointerFocusRef.current) {
              pointerFocusRef.current = false;
              return;
            }
            setOpen(true);
          }}
          aria-expanded={open}
          role="combobox"
          className={cn("w-full justify-between overflow-hidden", className, triggerClassName)}
        >
          <span className={cn("min-w-0 truncate", !selectedOption && "text-muted-foreground")}>
            {renderValue ? renderValue(selectedOption) : selectedOption?.label ?? placeholder}
          </span>
          <ChevronsUpDown className="ml-2 size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        collisionPadding={16}
        disablePortal={disablePortal}
        className={cn(
          "p-0",
          contentWidth === "trigger"
            ? "w-[var(--radix-popover-trigger-width)] min-w-56 max-w-[min(32rem,calc(100vw-2rem))]"
            : "w-72 max-w-[min(32rem,calc(100vw-2rem))]",
          contentClassName,
        )}
      >
        <Command
          shouldFilter={false}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={searchPlaceholder}
          />
          <CommandList>
            {loading ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">{loadingMessage}</div>
            ) : !hasOptions ? (
              <CommandEmpty>{emptyMessage}</CommandEmpty>
            ) : (
              filteredGroups.map((group) => (
                <CommandGroup key={group.id} heading={group.label}>
                  {group.options.map((option) => {
                    const selected = option.value === value;
                    return (
                      <CommandItem
                        key={option.key}
                        value={option.key}
                        disabled={option.disabled}
                        onSelect={() => selectOption(option)}
                      >
                        {renderOption
                          ? renderOption(option, { selected })
                          : <span className="min-w-0 truncate">{option.label}</span>}
                        <Check className={cn("ml-auto size-4", selected ? "opacity-100" : "opacity-0")} />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
