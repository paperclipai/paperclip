import * as React from "react";

export interface TabDefinition {
  id: string;
  label: string;
}

/**
 * Source-adapted shadcn Tabs rebuilt on the WAI-ARIA tabs pattern with a
 * roving tabindex. No radix runtime: arrow keys move, Home/End jump, Tab
 * enters the panel.
 */
export function Tabs({
  items,
  selected,
  onSelect,
  label,
  className = "",
  children,
}: {
  items: readonly TabDefinition[];
  selected: string;
  onSelect: (value: string) => void;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const idPrefix = React.useId();

  function moveFocus(nextIndex: number) {
    const normalizedIndex = (nextIndex + items.length) % items.length;
    const next = items[normalizedIndex];
    if (next === undefined) return;
    onSelect(next.id);
    const button = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[normalizedIndex];
    button?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = items.findIndex((tab) => tab.id === selected);
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveFocus(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveFocus(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveFocus(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveFocus(items.length - 1);
    }
  }

  return (
    <div data-slot="tabs" className={`pcr-tabs ${className}`.trim()}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={label}
        className="pcr-tablist"
        onKeyDown={onKeyDown}
      >
        {items.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab-id={tab.id}
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={tab.id === selected}
            aria-controls={`${idPrefix}-tabpanel-${tab.id}`}
            tabIndex={tab.id === selected ? 0 : -1}
            className="pcr-tab"
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${idPrefix}-tabpanel-${selected}`}
        aria-labelledby={`${idPrefix}-tab-${selected}`}
        tabIndex={0}
        className="pcr-tabpanel"
      >
        {children}
      </div>
    </div>
  );
}
