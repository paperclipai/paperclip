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
  className,
}: SidePanelTabProps) {
  const closeLabel = `Close ${label}`;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [labelIsTruncated, setLabelIsTruncated] = useState(false);
  const sizingKey = `${label}:${icon ? "icon" : "no-icon"}:${status ? "status" : "no-status"}:${closable ? "closable" : "fixed"}`;
  const [stableWidth, setStableWidth] = useState<{ key: string; width: number } | null>(null);
  const hasStableWidth = stableWidth?.key === sizingKey;

  useLayoutEffect(() => {
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
      style={hasStableWidth ? { width: stableWidth.width } : undefined}
      className={cn(
        "group/side-panel-tab relative flex h-(--side-panel-tab-height) min-w-0 shrink-0 items-center rounded-(--side-panel-tab-radius) border border-transparent",
        "side-panel-tab-motion",
        active
          ? "bg-(--side-panel-tab-active-bg) text-accent-foreground"
          : "text-muted-foreground hover:bg-(--side-panel-tab-hover-bg) hover:text-foreground",
        disabled && "opacity-50",
        className,
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            {...dragHandleProps}
            ref={tabRef}
            type="button"
            role="tab"
            data-side-panel-tab-target={id}
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
              "flex h-full w-full min-w-0 items-center gap-1.5 rounded-(--side-panel-tab-radius) py-1.5 pl-2 text-xs font-medium outline-none",
              closable && (!hasStableWidth || active) ? "pr-7" : "pr-2.5",
              "focus-visible:ring-2 focus-visible:ring-ring/60",
              dragHandleProps?.className,
            )}
          >
            {icon ? <span className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5">{icon}</span> : null}
            <span
              ref={labelRef}
              data-truncated={labelIsTruncated ? "true" : undefined}
              className={cn(
                "overflow-hidden whitespace-nowrap",
                closable && hasStableWidth && !active
                  ? "max-w-(--side-panel-tab-label-expanded-max-width)"
                  : "max-w-(--side-panel-tab-label-max-width)",
                labelIsTruncated && "side-panel-tab-label-fade",
              )}
            >
              {label}
            </span>
            {status ? <span className="flex shrink-0 items-center">{status}</span> : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      {closable && onClose && active ? (
        <button
          type="button"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="side-panel-tab-motion absolute right-1 flex size-6 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
