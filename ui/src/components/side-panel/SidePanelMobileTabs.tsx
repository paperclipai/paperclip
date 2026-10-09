import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { SidePanelTabItem } from "./types";

interface SidePanelMobileTabsProps {
  tabs: SidePanelTabItem[];
  activeTabId: string | null;
  onActiveTabChange: (id: string) => void;
  onCloseTab: (id: string) => void;
  addControl?: ReactNode;
}

/** A readable title and a vertical overview replace crowded desktop tabs. */
export function SidePanelMobileTabs({ tabs, activeTabId, onActiveTabChange, onCloseTab, addControl }: SidePanelMobileTabsProps) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    const enabled = tabs.filter((tab) => !tab.disabled);
    const index = enabled.findIndex((tab) => tab.id === id);
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = (index + 1) % enabled.length; break;
      case "ArrowUp": next = (index - 1 + enabled.length) % enabled.length; break;
      case "Home": next = 0; break;
      case "End": next = enabled.length - 1; break;
      default: return;
    }
    event.preventDefault();
    listRef.current?.querySelectorAll<HTMLButtonElement>("[data-mobile-tab-select]:not(:disabled)")[next]?.focus();
  }

  return (
    <div ref={headerRef} className="flex min-w-0 flex-1 items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            className="h-(--sz-44px) min-w-0 flex-1 justify-start gap-2 px-2"
            aria-label={`Switch tabs, ${tabs.length} open`}
            disabled={tabs.length === 0}
          >
            <span id={activeTab ? `side-panel-tab-${activeTab.id}` : undefined} className="min-w-0 flex-1 truncate text-left">{activeTab?.label ?? "Choose a tab"}</span>
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{tabs.length}</span>
            <ChevronDown aria-hidden className="shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Open tabs"
          align="start"
          className="w-(--side-panel-mobile-tabs-width) max-w-(--radix-popover-content-available-width) p-2"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-mobile-tab-select]:not(:disabled)");
            const selected = Array.from(buttons ?? []).find((button) => button.dataset.mobileTabSelect === activeTabId);
            (selected ?? buttons?.[0])?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (tabs.length !== 0) return;
            const addButton = headerRef.current?.querySelector<HTMLButtonElement>('[aria-label="Open a new tab"]');
            if (addButton) { event.preventDefault(); addButton.focus(); }
          }}
        >
          <p className="px-2 py-2 text-xs font-medium text-muted-foreground">Open tabs</p>
          <ul ref={listRef} aria-label="Open tabs" className="max-h-(--side-panel-mobile-tabs-max-height) overflow-y-auto overscroll-contain">
            {tabs.map((tab) => (
              <li key={tab.id} className={cn("flex items-center rounded-md", tab.id === activeTabId && "bg-muted")}>
                <button
                  type="button"
                  data-mobile-tab-select={tab.id}
                  disabled={tab.disabled}
                  aria-current={tab.id === activeTabId ? "true" : undefined}
                  aria-label={tab.ariaLabel ?? tab.label}
                  onKeyDown={(event) => moveFocus(event, tab.id)}
                  onClick={() => { onActiveTabChange(tab.id); setOpen(false); }}
                  className="flex min-h-(--sz-44px) min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <span aria-hidden className="shrink-0 text-muted-foreground [&_svg]:size-4">{tab.icon}</span>
                  <span className="min-w-0 flex-1 break-words">{tab.label}</span>
                  {tab.id === activeTabId ? <Check aria-hidden className="size-4 shrink-0" /> : null}
                </button>
                {tab.closable !== false ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-(--sz-44px) shrink-0"
                    aria-label={`Close ${tab.label}`}
                    disabled={tab.disabled}
                    onClick={() => {
                      // Focus the neighboring selector before removing the
                      // close button, so keyboard users stay in the overview.
                      const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-mobile-tab-select]:not(:disabled)") ?? []);
                      const index = buttons.findIndex((button) => button.dataset.mobileTabSelect === tab.id);
                      (buttons[index + 1] ?? buttons[index - 1])?.focus();
                      onCloseTab(tab.id);
                      if (tabs.length === 1) setOpen(false);
                    }}
                  ><X aria-hidden /></Button>
                ) : null}
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
      {addControl}
    </div>
  );
}
