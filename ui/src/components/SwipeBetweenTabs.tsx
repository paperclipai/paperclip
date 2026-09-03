import { useRef, type ReactNode, type TouchEvent } from "react";
import { cn } from "../lib/utils";

interface SwipeBetweenTabsProps {
  children: ReactNode;
  items: readonly string[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
}

const MIN_DISTANCE = 56;
const MAX_VERTICAL_DRIFT = 48;
const HORIZONTAL_INTENT_RATIO = 1.25;
const INTERACTIVE_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "[contenteditable='true']",
  "[data-swipe-navigation-ignore]",
  "[data-row-swipe-action]",
].join(",");

export function SwipeBetweenTabs({
  children,
  items,
  value,
  onValueChange,
  className,
}: SwipeBetweenTabsProps) {
  const startPointRef = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1) {
      startPointRef.current = null;
      return;
    }

    const target = event.target;
    if (target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) {
      startPointRef.current = null;
      return;
    }

    const touch = event.touches[0];
    startPointRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const startPoint = startPointRef.current;
    startPointRef.current = null;
    if (!startPoint || event.changedTouches.length !== 1) return;

    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - startPoint.x;
    const deltaY = touch.clientY - startPoint.y;
    if (
      Math.abs(deltaX) < MIN_DISTANCE
      || Math.abs(deltaY) > MAX_VERTICAL_DRIFT
      || Math.abs(deltaX) < Math.abs(deltaY) * HORIZONTAL_INTENT_RATIO
    ) return;

    const currentIndex = items.indexOf(value);
    if (currentIndex < 0) return;
    const nextIndex = deltaX < 0 ? currentIndex + 1 : currentIndex - 1;
    const nextValue = items[nextIndex];
    if (nextValue) onValueChange(nextValue);
  };

  return (
    <div
      className={cn("touch-pan-y", className)}
      data-swipe-between-tabs
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={() => { startPointRef.current = null; }}
    >
      {children}
    </div>
  );
}
