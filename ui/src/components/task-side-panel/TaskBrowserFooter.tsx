import {
  Clock3,
  LoaderCircle,
  Monitor,
  MoreHorizontal,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import {
  BROWSER_USE_IDLE_MS,
  BROWSER_USE_VIEWPORT_PRESETS,
  type BrowserUseViewportPreset,
  type BrowserUseControl,
  type TaskBrowser,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Session controls stay below the viewport; the countdown appears only near expiry. */
export function TaskBrowserFooter({
  browser,
  now,
  disabled = false,
  onControl,
  onReconnect,
  viewport = "fit",
  controlledElsewhere = false,
  resizing = false,
  resizeAvailable = true,
  onResize,
}: {
  browser: TaskBrowser;
  now: number;
  disabled?: boolean;
  onControl: (action: BrowserUseControl) => void;
  onReconnect: () => void;
  viewport?: BrowserUseViewportPreset;
  controlledElsewhere?: boolean;
  resizing?: boolean;
  resizeAvailable?: boolean;
  onResize: (preset: BrowserUseViewportPreset) => void;
}) {
  const live = browser.status === "running" || browser.status === "idle";
  const expiry = browser.expiresAt ? Date.parse(browser.expiresAt) : Infinity;
  const idleDeadline = browser.idleDeadline
    ? Date.parse(browser.idleDeadline)
    : Infinity;
  const deadline = Math.min(idleDeadline, expiry);
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  const closingSoon = browser.status === "idle" && seconds <= 5 * 60;
  const canExtend =
    browser.status === "idle" && expiry > idleDeadline && deadline > now;
  const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const sizeLabel =
    viewport === "fit"
      ? "Fit to pane"
      : (BROWSER_USE_VIEWPORT_PRESETS.find((p) => p.id === viewport)?.label ??
        "Default");
  if (!live) return null;

  return (
    <footer
      aria-label="Browser session"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground"
    >
      {closingSoon && (
        <span
          role="timer"
          aria-live="off"
          className="flex items-center gap-1 whitespace-nowrap"
        >
          <Clock3 className="size-3" aria-hidden="true" />
          {seconds > 0 ? (
            <>
              Closes in{" "}
              <span className="font-mono tabular-nums">{countdown}</span>
            </>
          ) : (
            "Closing…"
          )}
        </span>
      )}
      {controlledElsewhere && viewport === "fit" && (
        <span>Size follows another viewer</span>
      )}
      {resizing ? (
        <span role="status" className="flex items-center gap-1">
          <LoaderCircle
            className="size-3 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          Resizing…
        </span>
      ) : (
        browser.status === "running" && <span>Browsing</span>
      )}
      <div className="ml-auto flex items-center gap-1">
        {closingSoon && canExtend && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={() => onControl("keep_open")}
              >
                Keep browsing
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Keep this browser open for up to {BROWSER_USE_IDLE_MS / 60000}{" "}
              more minutes.
            </TooltipContent>
          </Tooltip>
        )}
        {browser.status === "running" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={() => onControl("cancel")}
              >
                <Square aria-hidden="true" /> Stop browsing
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Stop the agent’s browser work and leave the browser open.
            </TooltipContent>
          </Tooltip>
        )}
        {live && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Browser options"
                disabled={disabled}
              >
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="w-64">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={resizing || !resizeAvailable}>
                  <Monitor aria-hidden="true" />
                  <span>Browser size</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {sizeLabel}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-64">
                  <DropdownMenuLabel>Browser size</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={viewport}
                    onValueChange={(value) =>
                      onResize(value as BrowserUseViewportPreset)
                    }
                  >
                    <DropdownMenuRadioItem
                      value="fit"
                      onSelect={() => {
                        if (viewport === "fit") onResize("fit");
                      }}
                    >
                      Fit to pane
                    </DropdownMenuRadioItem>
                    {controlledElsewhere && (
                      <DropdownMenuItem onSelect={() => onResize("fit")}>
                        Fit to this pane instead
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuRadioItem
                      value="default"
                      onSelect={() => {
                        if (viewport === "default") onResize("default");
                      }}
                    >
                      Browser default
                    </DropdownMenuRadioItem>
                    <DropdownMenuSeparator />
                    {BROWSER_USE_VIEWPORT_PRESETS.map((preset) => (
                      <DropdownMenuRadioItem
                        key={preset.id}
                        value={preset.id}
                        onSelect={() => {
                          if (viewport === preset.id) onResize(preset.id);
                        }}
                      >
                        <span>{preset.label}</span>
                        <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
                          {preset.width} × {preset.height}
                        </span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onReconnect} className="items-start">
                <RefreshCw className="mt-0.5" aria-hidden="true" />
                <span className="flex flex-col gap-1">
                  <span>Reconnect view</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    Reload the live view. Browser work keeps running.
                  </span>
                </span>
              </DropdownMenuItem>
              {canExtend && (
                <DropdownMenuItem
                  onSelect={() => onControl("keep_open")}
                  className="items-start"
                >
                  <Clock3 className="mt-0.5" aria-hidden="true" />
                  <span className="flex flex-col gap-1">
                    <span>Keep browser open</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      Keep it open for up to 10 more minutes.
                    </span>
                  </span>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => onControl("end")}
                className="items-start"
              >
                <X className="mt-0.5" aria-hidden="true" />
                <span className="flex flex-col gap-1">
                  <span>Close browser</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    End this browser and stop any browsing.
                  </span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </footer>
  );
}
