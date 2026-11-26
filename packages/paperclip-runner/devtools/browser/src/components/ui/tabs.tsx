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
  tabs,
  value,
  onValueChange,
  label,
  className = "",
  children,
}: {
  tabs: readonly TabDefinition[];
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);

  function moveFocus(nextIndex: number) {
    const next = tabs[(nextIndex + tabs.length) % tabs.length];
    if (next === undefined) return;
    onValueChange(next.id);
    const button = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-tab-id="${next.id}"]`,
    );
    button?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === value);
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
      moveFocus(tabs.length - 1);
    }
  }

  return (
    <div data-slot="tabs" className={`ui-tabs ${className}`.trim()}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={label}
        className="ui-tablist"
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab-id={tab.id}
            id={`tab-${tab.id}`}
            aria-selected={tab.id === value}
            aria-controls={`tabpanel-${tab.id}`}
            tabIndex={tab.id === value ? 0 : -1}
            className="ui-tab"
            onClick={() => onValueChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`tabpanel-${value}`}
        aria-labelledby={`tab-${value}`}
        tabIndex={0}
        className="ui-tabpanel"
      >
        {children}
      </div>
    </div>
  );
}
