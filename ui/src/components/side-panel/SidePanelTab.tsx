import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode, type Ref } from "react";
import { X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface SidePanelTabProps {
  id: string;
  label: string;
  ariaLabel?: string;
  icon?: ReactNode;
  status?: ReactNode;
  active: boolean;
  closable?: boolean;
  disabled?: boolean;
  tabRef?: Ref<HTMLButtonElement>;
  dragHandleProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  onSelect: () => void;
  onClose?: () => void;
  onAuxClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown?: ButtonHTMLAttributes<HTMLButtonElement>["onKeyDown"];
  appearance?: "default" | "streamlined-task";
  className?: string;
}

export function SidePanelTab({
  id,
  label,
  ariaLabel,
  icon,
  status,
  active,
  closable = true,
  disabled = false,
  tabRef,
  dragHandleProps,
  onSelect,
  onClose,
  onAuxClick,
  onKeyDown,
  appearance = "default",
  className,
}: SidePanelTabProps) {
  const closeLabel = `Close ${label}`;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [labelIsTruncated, setLabelIsTruncated] = useState(false);
  const sizingKey = `${appearance}:${label}:${icon ? "icon" : "no-icon"}:${status ? "status" : "no-status"}:${closable ? "closable" : "fixed"}`;
  const [stableWidth, setStableWidth] = useState<{ key: string; width: number } | null>(null);
  const hasStableWidth = stableWidth?.key === sizingKey;

  useLayoutEffect(() => {
    if (appearance === "streamlined-task") return;
    if (hasStableWidth) return;
    const measuredWidth = wrapperRef.current?.getBoundingClientRect().width ?? 0;
    if (measuredWidth <= 0) return;
    setStableWidth({ key: sizingKey, width: Math.ceil(measuredWidth) });
  }, [hasStableWidth, sizingKey]);

  useEffect(() => {
    const labelElement = labelRef.current;
    if (!labelElement) return;
    const updateTruncation = () => {
      setLabelIsTruncated(labelElement.scrollWidth > labelElement.clientWidth);
    };
    updateTruncation();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateTruncation);
    observer.observe(labelElement);
    return () => observer.disconnect();
  }, [label]);

  return (
    <div
      ref={wrapperRef}
      data-side-panel-tab-wrapper={id}
      data-active={active ? "true" : "false"}
      data-appearance={appearance}
      style={appearance === "default" && hasStableWidth ? { width: stableWidth.width } : undefined}
      className={cn(
        appearance === "streamlined-task"
          ? "group/side-panel-tab relative mx-1.5 flex h-7 min-w-0 flex-1 basis-0 items-center rounded-md border border-transparent"
          : "group/side-panel-tab relative flex h-(--side-panel-tab-height) min-w-0 shrink-0 items-center rounded-(--side-panel-tab-radius) border border-transparent",
        "side-panel-tab-motion",
        active
          ? appearance === "streamlined-task"
            ? "text-foreground hover:bg-accent/50"
            : "bg-(--side-panel-tab-active-bg) text-accent-foreground"
          : appearance === "streamlined-task"
            ? "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            : "text-muted-foreground hover:bg-(--side-panel-tab-hover-bg) hover:text-foreground",
        disabled && "opacity-50",
        className,
      )}
    >
      <Tooltip open={labelIsTruncated ? undefined : false}>
        <TooltipTrigger asChild>
          <button
            {...dragHandleProps}
            ref={tabRef}
            type="button"
            role="tab"
            data-side-panel-tab-target={id}
            data-side-panel-tab-tooltip={labelIsTruncated ? "enabled" : "disabled"}
            id={`side-panel-tab-${id}`}
            aria-controls={`side-panel-content-${id}`}
            aria-selected={active}
            aria-label={ariaLabel ?? label}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={onSelect}
            onAuxClick={onAuxClick}
            onKeyDown={onKeyDown}
            className={cn(
              appearance === "streamlined-task"
                ? "flex h-full w-full min-w-0 items-center justify-start rounded-md px-3 text-sm font-medium outline-none"
                : "flex h-full w-full min-w-0 items-center gap-1.5 rounded-(--side-panel-tab-radius) py-1.5 pl-2 text-xs font-medium outline-none",
              appearance === "default" && (closable && (!hasStableWidth || active) ? "pr-7" : "pr-2.5"),
              "focus-visible:ring-2 focus-visible:ring-ring/60",
              dragHandleProps?.className,
            )}
          >
            {icon && appearance === "default" ? <span className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5">{icon}</span> : null}
            <span
              ref={labelRef}
              data-truncated={labelIsTruncated ? "true" : undefined}
              className={cn(
                appearance === "streamlined-task"
                  ? "side-panel-tab-label-close-fade task-detail-pane-tab-label min-w-0 flex-1 overflow-hidden whitespace-nowrap text-center"
                  : "overflow-hidden whitespace-nowrap",
                appearance === "default" && (
                  closable && hasStableWidth && !active
                    ? "max-w-(--side-panel-tab-label-expanded-max-width)"
                    : "max-w-(--side-panel-tab-label-max-width)"
                ),
                appearance === "default" && labelIsTruncated && "side-panel-tab-label-fade",
              )}
            >
              {label}
            </span>
            {status ? (
              <span className={cn(
                "flex shrink-0 items-center",
                appearance === "streamlined-task" && "transition-opacity group-hover/side-panel-tab:opacity-0 group-focus-within/side-panel-tab:opacity-0",
              )}>
                {status}
              </span>
            ) : null}
          </button>
        </TooltipTrigger>
        {labelIsTruncated ? <TooltipContent side="bottom">{label}</TooltipContent> : null}
      </Tooltip>
      {closable && onClose && (appearance === "streamlined-task" || active) ? (
        <button
          type="button"
          aria-label={closeLabel}
          title={closeLabel}
          onPointerDown={(event) => {
            if (appearance !== "streamlined-task") return;
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className={cn(
            "side-panel-tab-close-motion absolute flex items-center justify-center text-muted-foreground outline-none hover:text-foreground",
            appearance === "streamlined-task"
              ? "right-0 top-1/2 z-20 size-5 -translate-y-1/2 rounded-sm opacity-0 hover:bg-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60 group-hover/side-panel-tab:opacity-100"
              : "right-1 size-6 rounded-lg hover:bg-background/70 focus-visible:ring-2 focus-visible:ring-ring/60",
          )}
        >
          <X className={appearance === "streamlined-task" ? "size-3.5" : "size-3"} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
