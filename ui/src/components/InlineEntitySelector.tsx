import { forwardRef, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "../lib/utils";

export interface InlineEntityOption {
  id: string;
  label: string;
  searchText?: string;
}

interface InlineEntitySelectorProps {
  value: string;
  options: InlineEntityOption[];
  placeholder: string;
  noneLabel: string;
  searchPlaceholder: string;
  emptyMessage: string;
  onChange: (id: string) => void;
  onConfirm?: () => void;
  className?: string;
  renderTriggerValue?: (option: InlineEntityOption | null) => ReactNode;
  renderOption?: (option: InlineEntityOption, isSelected: boolean) => ReactNode;
  /** Skip the Portal so the popover stays in the DOM tree (fixes scroll inside Dialogs). */
  disablePortal?: boolean;
  /** Open the popover when the trigger receives keyboard/programmatic focus. */
  openOnFocus?: boolean;
}

export const InlineEntitySelector = forwardRef<HTMLButtonElement, InlineEntitySelectorProps>(
  function InlineEntitySelector(
    {
      value,
      options,
      placeholder,
      noneLabel,
      searchPlaceholder,
      emptyMessage,
      onChange,
      onConfirm,
      className,
      renderTriggerValue,
      renderOption,
      disablePortal,
      openOnFocus = true,
    },
    ref,
  ) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const shouldPreventCloseAutoFocusRef = useRef(false);
    const isPointerDownRef = useRef(false);

    const allOptions = useMemo<InlineEntityOption[]>(
      () => [{ id: "", label: noneLabel, searchText: noneLabel }, ...options],
      [noneLabel, options],
    );

    const filteredOptions = useMemo(() => {
      const term = query.trim().toLowerCase();
      if (!term) return allOptions;
      return allOptions.filter((option) => {
        const haystack = `${option.label} ${option.searchText ?? ""}`.toLowerCase();
        return haystack.includes(term);
      });
    }, [allOptions, query]);

    const currentOption = options.find((option) => option.id === value) ?? null;

    useEffect(() => {
      if (!open) return;
      const selectedIndex = filteredOptions.findIndex((option) => option.id === value);
      setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    }, [filteredOptions, open, value]);

    const commitSelection = (index: number, moveNext: boolean) => {
      const option = filteredOptions[index] ?? filteredOptions[0];
      if (option) onChange(option.id);
      shouldPreventCloseAutoFocusRef.current = moveNext;
      setOpen(false);
      setQuery("");
      if (moveNext && onConfirm) {
        requestAnimationFrame(() => {
          onConfirm();
        });
      }
    };

    return (
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <button
            ref={ref}
            type="button"
            className={cn(
              "inline-flex min-w-0 items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-sm font-medium text-foreground transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              className,
            )}
            onPointerDown={() => { isPointerDownRef.current = true; }}
            onFocus={() => {
              if (openOnFocus && !isPointerDownRef.current) setOpen(true);
              isPointerDownRef.current = false;
            }}
          >
            {renderTriggerValue
              ? renderTriggerValue(currentOption)
              : (currentOption?.label ?? <span className="text-muted-foreground">{placeholder}</span>)}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          collisionPadding={16}
          className="w-[min(20rem,calc(100vw-2rem))] p-1"
          disablePortal={disablePortal}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            // On touch devices, don't auto-focus the search input to avoid
            // opening the virtual keyboard which reshapes the viewport and
            // pushes the popover off-screen.
            const isTouch = typeof window.matchMedia === "function"
              ? window.matchMedia("(pointer: coarse)").matches
              : false;
            if (!isTouch) {
              inputRef.current?.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            if (!shouldPreventCloseAutoFocusRef.current) return;
            event.preventDefault();
            shouldPreventCloseAutoFocusRef.current = false;
          }}
        >
          <input
            ref={inputRef}
            className="w-full border-b border-border bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/60"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlightedIndex((current) =>
                  filteredOptions.length === 0 ? 0 : (current + 1) % filteredOptions.length,
                );
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlightedIndex((current) => {
                  if (filteredOptions.length === 0) return 0;
                  return current <= 0 ? filteredOptions.length - 1 : current - 1;
                });
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                commitSelection(highlightedIndex, true);
                return;
              }
              if (event.key === "Tab" && !event.shiftKey) {
                event.preventDefault();
                commitSelection(highlightedIndex, true);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
              }
            }}
          />
          <div className="max-h-56 overflow-y-auto overscroll-contain py-1 touch-pan-y">
            {filteredOptions.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">{emptyMessage}</p>
            ) : (
              filteredOptions.map((option, index) => {
                const isSelected = option.id === value;
                const isHighlighted = index === highlightedIndex;
                return (
                  <button
                    key={option.id || "__none__"}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm touch-manipulation",
                      isHighlighted && "bg-accent",
                    )}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => commitSelection(index, true)}
                  >
                    {renderOption ? renderOption(option, isSelected) : <span className="truncate">{option.label}</span>}
                    <Check className={cn("ml-auto h-3.5 w-3.5 text-muted-foreground", isSelected ? "opacity-100" : "opacity-0")} />
                  </button>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    );
  },
);
