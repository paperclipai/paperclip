import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FoldCurtainProps {
  children: ReactNode;
  /** Max height (px) when collapsed. Defaults to 420 (desktop) / 320 (< 640px viewport). */
  collapsedHeight?: number;
  /** Only curtain when natural height ≥ collapsedHeight + this buffer. */
  activationBuffer?: number;
  moreLabel?: string;
  lessLabel?: string;
  className?: string;
  contentClassName?: string;
}

const MOBILE_BREAKPOINT = 640;
const MOBILE_COLLAPSED_HEIGHT = 320;
const DEFAULT_COLLAPSED_HEIGHT = 420;
const FADE_HEIGHT_PX = 72;
const EXPAND_TRANSITION_MS = 220;

function useResponsiveCollapsedHeight(explicit?: number) {
  const [height, setHeight] = useState<number>(() => {
    if (explicit != null) return explicit;
    if (typeof window === "undefined") return DEFAULT_COLLAPSED_HEIGHT;
    return window.innerWidth < MOBILE_BREAKPOINT
      ? MOBILE_COLLAPSED_HEIGHT
      : DEFAULT_COLLAPSED_HEIGHT;
  });

  useEffect(() => {
    if (explicit != null) {
      setHeight(explicit);
      return;
    }
    if (typeof window === "undefined") return;
    const compute = () =>
      setHeight(
        window.innerWidth < MOBILE_BREAKPOINT
          ? MOBILE_COLLAPSED_HEIGHT
          : DEFAULT_COLLAPSED_HEIGHT,
      );
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [explicit]);

  return height;
}

export function FoldCurtain({
  children,
  collapsedHeight: explicitCollapsedHeight,
  activationBuffer = 120,
  moreLabel = "Show more",
  lessLabel = "Show less",
  className,
  contentClassName,
}: FoldCurtainProps) {
  const collapsedHeight = useResponsiveCollapsedHeight(explicitCollapsedHeight);
  const contentRef = useRef<HTMLDivElement>(null);
  const [naturalHeight, setNaturalHeight] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [hasMeasured, setHasMeasured] = useState(false);
  const [allowTransition, setAllowTransition] = useState(false);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => {
      setNaturalHeight(el.scrollHeight);
      setHasMeasured(true);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const shouldCurtain = hasMeasured && naturalHeight >= collapsedHeight + activationBuffer;
  const isClipped = shouldCurtain && !expanded;

  const maskStyle = isClipped
    ? {
        WebkitMaskImage: `linear-gradient(to bottom, black 0, black calc(100% - ${FADE_HEIGHT_PX}px), transparent 100%)`,
        maskImage: `linear-gradient(to bottom, black 0, black calc(100% - ${FADE_HEIGHT_PX}px), transparent 100%)`,
      }
    : undefined;

  return (
    <div className={cn("fold-curtain", className)} data-expanded={expanded ? "true" : "false"}>
      <div
        ref={contentRef}
        className={cn(
          "fold-curtain__content relative overflow-hidden",
          allowTransition && "motion-safe:transition-[max-height] motion-reduce:transition-none",
          contentClassName,
        )}
        style={{
          maxHeight: isClipped
            ? `${collapsedHeight}px`
            : shouldCurtain
              ? `${naturalHeight}px`
              : undefined,
          transitionDuration: allowTransition ? `${EXPAND_TRANSITION_MS}ms` : undefined,
          transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
          ...maskStyle,
        }}
      >
        {children}
      </div>
      {shouldCurtain ? (
        <div className="fold-curtain__toggle mt-2 flex justify-center print:hidden">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => {
              setAllowTransition(true);
              setExpanded((v) => !v);
            }}
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {expanded ? lessLabel : moreLabel}
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
