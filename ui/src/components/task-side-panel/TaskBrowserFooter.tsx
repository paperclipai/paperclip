import { t, useTranslation, Trans } from "@/i18n";
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
  useTranslation("task-components");
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
      ? t("task-components:fitToPane_4afeed1a")
      : (BROWSER_USE_VIEWPORT_PRESETS.find((p) => p.id === viewport)?.label ??
        t("task-components:default_21b111cb"));
  if (!live) return null;

  return (
    <footer
      aria-label={t("task-components:browserSession_ccf3756d")}
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
            <>{t("task-components:closesIn_0d844154")}{" "}
              <span className="font-mono tabular-nums">{countdown}</span>
            </>
          ) : (
            t("task-components:closing_abdb0cfd")
          )}
        </span>
      )}
      {controlledElsewhere && viewport === "fit" && (
        <span>{t("task-components:sizeFollowsAnotherViewer_a9be4d07")}</span>
      )}
      {resizing ? (
        <span role="status" className="flex items-center gap-1">
          <LoaderCircle
            className="size-3 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />{t("task-components:resizing_6f2769b2")}</span>
      ) : (
        browser.status === "running" && <span>{t("task-components:browsing_bd6eb3cf")}</span>
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
              >{t("task-components:keepBrowsing_a1ecf492")}</Button>
            </TooltipTrigger>
            <TooltipContent><Trans ns="task-components" i18nKey="sentence_be8b0619b4a8" components={{ part1: <>{BROWSER_USE_IDLE_MS / 60000}</> }} /></TooltipContent>
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
                <Square aria-hidden="true" />{" "}{t("task-components:stopBrowsing_5698d349")}</Button>
            </TooltipTrigger>
            <TooltipContent>{t("task-components:stopTheAgentSBrowserWorkAnd_8a3f8971")}</TooltipContent>
          </Tooltip>
        )}
        {live && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("task-components:browserOptions_0017e5fb")}
                disabled={disabled}
              >
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="w-64">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={resizing || !resizeAvailable}>
                  <Monitor aria-hidden="true" />
                  <span>{t("task-components:browserSize_ccc196e0")}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {sizeLabel}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-64">
                  <DropdownMenuLabel>{t("task-components:browserSize_ccc196e0")}</DropdownMenuLabel>
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
                    >{t("task-components:fitToPane_4afeed1a")}</DropdownMenuRadioItem>
                    {controlledElsewhere && (
                      <DropdownMenuItem onSelect={() => onResize("fit")}>{t("task-components:fitToThisPaneInstead_0b459f06")}</DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuRadioItem
                      value="default"
                      onSelect={() => {
                        if (viewport === "default") onResize("default");
                      }}
                    >{t("task-components:browserDefault_44f05276")}</DropdownMenuRadioItem>
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
                  <span>{t("task-components:reconnectView_96216c2c")}</span>
                  <span className="text-xs font-normal text-muted-foreground">{t("task-components:reloadTheLiveViewBrowserWorkKeeps_8aa42041")}</span>
                </span>
              </DropdownMenuItem>
              {canExtend && (
                <DropdownMenuItem
                  onSelect={() => onControl("keep_open")}
                  className="items-start"
                >
                  <Clock3 className="mt-0.5" aria-hidden="true" />
                  <span className="flex flex-col gap-1">
                    <span>{t("task-components:keepBrowserOpen_5a76dedb")}</span>
                    <span className="text-xs font-normal text-muted-foreground">{t("task-components:keepItOpenForUpTo10_71328167")}</span>
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
                  <span>{t("task-components:closeBrowser_dd33033e")}</span>
                  <span className="text-xs font-normal text-muted-foreground">{t("task-components:endThisBrowserAndStopAnyBrowsing_3bbffb16")}</span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </footer>
  );
}
