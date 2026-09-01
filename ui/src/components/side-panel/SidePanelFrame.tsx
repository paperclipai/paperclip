import type { CSSProperties, ReactNode } from "react";
import { Maximize2, Minimize2, PanelRightClose, PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { SidePanelContentMode, SidePanelPresentation } from "./types";
import { useScrollbarWhileScrolling } from "./use-scrollbar-while-scrolling";

export interface SidePanelFrameProps {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  trailingControls?: ReactNode;
  presentation?: SidePanelPresentation;
  contentMode?: SidePanelContentMode;
  open?: boolean;
  maximized?: boolean;
  resizing?: boolean;
  label?: string;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
}

export function SidePanelFrame({
  children,
  header,
  footer,
  trailingControls,
  presentation = "docked",
  contentMode = "padded",
  open = true,
  maximized = false,
  resizing = false,
  label = "Side panel",
  className,
  bodyClassName,
  style,
}: SidePanelFrameProps) {
  const handleScroll = useScrollbarWhileScrolling();
  return (
    <section
      aria-label={label}
      aria-hidden={!open}
      data-presentation={presentation}
      data-open={open ? "true" : "false"}
      data-maximized={maximized ? "true" : "false"}
      data-resizing={resizing ? "true" : "false"}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden bg-(--side-panel-bg) text-(--side-panel-fg)",
        presentation === "docked" && "h-full border-l border-border",
        presentation === "sheet" && "h-full w-full",
        presentation === "embedded" && "h-full rounded-xl border border-border",
        !open && "pointer-events-none opacity-0",
        className,
      )}
      style={style}
    >
      {(header || trailingControls) ? (
        <header className="flex h-(--side-panel-header-height) min-w-0 shrink-0 items-center gap-1 px-2">
          <div className="flex min-w-0 flex-1 self-stretch">{header}</div>
          {trailingControls ? (
            <div className="flex shrink-0 items-center gap-1">{trailingControls}</div>
          ) : null}
        </header>
      ) : null}
      <div
        data-side-panel-content-viewport="true"
        onScroll={handleScroll}
        className={cn(
          "min-h-0 flex-1",
          contentMode === "full-bleed" ? "overflow-hidden" : "overflow-auto",
          contentMode !== "full-bleed" && "scrollbar-while-scrolling",
          contentMode === "padded" && "p-4",
          bodyClassName,
        )}
      >
        {contentMode === "prose" ? (
          <div data-side-panel-prose-content="true" className="mx-auto w-full max-w-4xl px-6 py-4">
            {children}
          </div>
        ) : children}
      </div>
      {footer ? <footer className="shrink-0 border-t border-border">{footer}</footer> : null}
    </section>
  );
}

export function SidePanelToggleButton({
  open,
  onToggle,
  shortcut,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  shortcut?: string;
  className?: string;
}) {
  const label = "Toggle side panel";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={open}
          onClick={onToggle}
          className={cn(
            "h-(--side-panel-tab-height) w-(--side-panel-tab-height)",
            open && "bg-accent text-accent-foreground",
            className,
          )}
        >
          {open ? <PanelRightClose aria-hidden /> : <PanelRightOpen aria-hidden />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {shortcut ? `${label} (${shortcut})` : label}
      </TooltipContent>
    </Tooltip>
  );
}

export function SidePanelWindowControls({
  maximized,
  onMaximizedChange,
  onToggle,
}: {
  maximized: boolean;
  onMaximizedChange: (maximized: boolean) => void;
  onToggle: () => void;
}) {
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="h-(--side-panel-tab-height) w-(--side-panel-tab-height) text-muted-foreground hover:text-foreground focus-visible:text-foreground"
        onClick={() => onMaximizedChange(!maximized)}
        aria-label={maximized ? "Restore side panel" : "Maximize side panel"}
        title={maximized ? "Restore side panel" : "Maximize side panel"}
      >
        {maximized ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
      </Button>
      <SidePanelToggleButton open onToggle={onToggle} />
    </>
  );
}
