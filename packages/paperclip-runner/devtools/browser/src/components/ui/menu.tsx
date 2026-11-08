import * as React from "react";

export interface MenuItemDefinition {
  id: string;
  label: string;
  enabled: boolean;
  /** Exact upstream diagnostic; exposed through aria-describedby, not hover. */
  reason: string | null;
}

/**
 * Source-adapted shadcn DropdownMenu narrowed to the menu-button pattern the
 * goal surface needs. Five fixed verbs, no search, no radix portal.
 */
export function Menu({
  label,
  items,
  onSelect,
  disabled = false,
  disabledReason = null,
  triggerId,
}: {
  label: string;
  items: readonly MenuItemDefinition[];
  onSelect: (id: string) => void;
  disabled?: boolean;
  disabledReason?: string | null;
  triggerId: string;
}) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const descriptionId = `${triggerId}-reason`;

  React.useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function focusItem(index: number) {
    const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]',
    );
    if (buttons === undefined || buttons.length === 0) return;
    buttons[(index + buttons.length) % buttons.length]?.focus();
  }

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (["ArrowDown", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      setOpen(true);
      window.setTimeout(() => focusItem(0), 0);
    }
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const buttons = [
      ...(containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(index - 1);
    }
  }

  return (
    <div ref={containerRef} data-slot="menu" className="ui-menu">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="ui-button ui-button--quiet"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={disabled}
        {...(disabled && disabledReason !== null ? { "aria-describedby": descriptionId } : {})}
        onClick={() => {
          if (disabled) return;
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          onTriggerKeyDown(event);
        }}
      >
        {label}
        <span aria-hidden="true"> ▾</span>
      </button>
      {disabled && disabledReason !== null ? (
        <p id={descriptionId} className="ui-menu-reason">
          {disabledReason}
        </p>
      ) : null}
      {open && !disabled ? (
        <div role="menu" aria-labelledby={triggerId} className="ui-menu-list" onKeyDown={onMenuKeyDown}>
          {items.map((item) => {
            const itemReasonId = `${triggerId}-${item.id}-reason`;
            return (
              <React.Fragment key={item.id}>
                <button
                  type="button"
                  role="menuitem"
                  className="ui-menu-item"
                  aria-disabled={!item.enabled}
                  {...(item.reason === null ? {} : { "aria-describedby": itemReasonId })}
                  onClick={() => {
                    if (!item.enabled) return;
                    setOpen(false);
                    onSelect(item.id);
                  }}
                >
                  {item.label}
                </button>
                {item.reason === null ? null : (
                  <p id={itemReasonId} className="ui-menu-reason">
                    {item.reason}
                  </p>
                )}
              </React.Fragment>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
