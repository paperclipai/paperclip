import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { readStoredView, writeStoredView, type ViewOption } from "@/lib/responsibility-views";
import { cn } from "@/lib/utils";

/**
 * The view a page shows, remembered per page in local storage. Starts from
 * the stored choice (or `fallback`, else the first option) and works without storage.
 * `requested` (a view a link asked for, such as `?view=`) wins and is remembered.
 */
export function useStoredView<T extends string>(
  key: string,
  options: readonly ViewOption<T>[],
  fallback?: T,
  requested?: T | null,
): [T, (view: T) => void] {
  const [view, setView] = useState<T>(() => requested ?? readStoredView(key, options, fallback));
  const choose = useCallback((next: T) => {
    setView(next);
    writeStoredView(key, next);
  }, [key]);
  useEffect(() => {
    if (requested) choose(requested);
  }, [requested, choose]);
  return [view, choose];
}

/**
 * A small segmented switch between a page's views: one radio group, arrow
 * keys move the choice, and only the chosen option is in the tab order.
 */
export function ViewSwitcher<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: readonly ViewOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const select = (index: number) => {
    const wrapped = (index + options.length) % options.length;
    onChange(options[wrapped]!.value);
    buttons.current[wrapped]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown" ? index + 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp" ? index - 1
          : event.key === "Home" ? 0
            : event.key === "End" ? options.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    select(next);
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5", className)}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-view={option.value}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "whitespace-nowrap rounded-sm px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              checked && "bg-accent text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
