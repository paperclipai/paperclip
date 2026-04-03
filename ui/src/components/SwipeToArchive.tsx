import { useEffect, useRef, useState, type ReactNode } from "react";
import { Archive } from "lucide-react";
import { cn } from "../lib/utils";

interface SwipeToArchiveProps {
  children: ReactNode;
  onArchive: () => void;
  disabled?: boolean;
  selected?: boolean;
  className?: string;
}

const COMMIT_THRESHOLD = 0.32;
const MAX_SWIPE = 0.88;
const COMMIT_DELAY_MS = 140;

export function SwipeToArchive({
  children,
  onArchive,
  disabled = false,
  selected = false,
  className,
}: SwipeToArchiveProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const startPointRef = useRef<{ x: number; y: number } | null>(null);
  const widthRef = useRef(0);
  const timeoutRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const [offsetX, setOffsetX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isCollapsing, setIsCollapsing] = useState(false);
  const [lockedHeight, setLockedHeight] = useState<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const reset = () => {
    startPointRef.current = null;
    setIsDragging(false);
    setOffsetX(0);
  };

  const commitArchive = () => {
    const node = containerRef.current;
    if (!node) {
      onArchive();
      return;
    }
    setIsDragging(false);
    setLockedHeight(node.offsetHeight);
    setOffsetX(-Math.max(widthRef.current, node.offsetWidth));
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        setIsCollapsing(true);
      });
    });
    timeoutRef.current = window.setTimeout(() => {
      onArchive();
    }, COMMIT_DELAY_MS);
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (disabled || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const node = containerRef.current;
    widthRef.current = node?.offsetWidth ?? 0;
    setLockedHeight(node?.offsetHeight ?? null);
    setIsCollapsing(false);
    suppressClickRef.current = false;
    startPointRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    if (disabled || isCollapsing) return;
    const startPoint = startPointRef.current;
    if (!startPoint || event.touches.length !== 1) return;

    const touch = event.touches[0];
    const deltaX = touch.clientX - startPoint.x;
    const deltaY = touch.clientY - startPoint.y;

    if (!isDragging) {
      if (Math.abs(deltaX) < 6) return;
      if (Math.abs(deltaY) > Math.abs(deltaX)) {
        startPointRef.current = null;
        return;
      }
      suppressClickRef.current = true;
    }

    if (deltaX >= 0) {
      event.preventDefault();
      setIsDragging(true);
      setOffsetX(0);
      return;
    }

    const maxSwipe = widthRef.current > 0 ? widthRef.current * MAX_SWIPE : Number.POSITIVE_INFINITY;
    event.preventDefault();
    setIsDragging(true);
    setOffsetX(Math.max(deltaX, -maxSwipe));
  };

  const handleTouchEnd = () => {
    if (disabled || isCollapsing) return;
    const shouldCommit =
      widthRef.current > 0 && Math.abs(offsetX) >= widthRef.current * COMMIT_THRESHOLD;
    if (shouldCommit) {
      commitArchive();
      return;
    }
    reset();
  };

  const archiveReveal = widthRef.current > 0 ? Math.min(Math.abs(offsetX) / widthRef.current, 1) : 0;

  return (
    <div
      ref={containerRef}
      className={cn("relative overflow-hidden touch-pan-y", className)}
      style={{
        height: lockedHeight === null ? undefined : isCollapsing ? 0 : lockedHeight,
        opacity: isCollapsing ? 0 : 1,
        transition: isCollapsing ? "height 200ms ease, opacity 200ms ease" : undefined,
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = false;
      }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-end bg-emerald-600 px-4 text-white"
        style={{ opacity: Math.max(archiveReveal, 0.2) }}
      >
        <span className="inline-flex items-center gap-2 text-sm font-medium">
          <Archive className="h-4 w-4" />
          Archive
        </span>
      </div>
      <div
        data-inbox-row-surface
        className={cn(
          "relative will-change-transform",
          selected ? "bg-zinc-100 dark:bg-zinc-800" : "bg-card",
        )}
        style={{
          transform: `translate3d(${offsetX}px, 0, 0)`,
          transition: isDragging ? "none" : "transform 180ms ease-out",
        }}
      >
        {children}
      </div>
    </div>
  );
}
