import { useEffect, useState, type ReactNode } from "react";

interface SkeletonBoneProps {
  /** Width (CSS value, default "100%"). */
  width?: string;
  /** Height (CSS value, default "1rem"). */
  height?: string;
  /** Border radius (CSS value, default "0.375rem" = rounded-md). */
  rounded?: string;
  className?: string;
}

/**
 * A single skeleton placeholder bone with pulsing animation.
 */
export function SkeletonBone({
  width = "100%",
  height = "1rem",
  rounded = "0.375rem",
  className = "",
}: SkeletonBoneProps) {
  return (
    <div
      className={`animate-pulse bg-muted/60 ${className}`}
      style={{ width, height, borderRadius: rounded }}
      aria-hidden="true"
    />
  );
}

interface SkeletonTextProps {
  /** Number of lines (default 3). */
  lines?: number;
  /** Width of each line as a percentage array; last line defaults to 60%. */
  lineWidths?: string[];
  className?: string;
}

/**
 * A block of skeleton text lines — good for card bodies or content previews.
 */
export function SkeletonText({ lines = 3, lineWidths, className = "" }: SkeletonTextProps) {
  const items = Array.from({ length: lines }, (_, i) => ({
    key: i,
    width: lineWidths?.[i] ?? (i === lines - 1 ? "60%" : "100%"),
  }));

  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {items.map(({ key, width }) => (
        <SkeletonBone key={key} width={width} />
      ))}
    </div>
  );
}

interface FadeInProps {
  /** Delay in ms before the fade-in starts (default 0). */
  delayMs?: number;
  /** Fade-in duration in ms (default 300). */
  durationMs?: number;
  children: ReactNode;
  className?: string;
}

/**
 * A fade-in wrapper for content that loads non-blocking data.
 *
 * Usage:
 * ```tsx
 * {isLoading ? (
 *   <SkeletonText lines={4} />
 * ) : (
 *   <FadeIn>
 *     <ActualContent />
 *   </FadeIn>
 * )}
 * ```
 */
export function FadeIn({ delayMs = 0, durationMs = 300, children, className = "" }: FadeInProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);

  return (
    <div
      className={`transition-opacity ${className}`}
      style={{
        opacity: visible ? 1 : 0,
        transitionDuration: `${durationMs}ms`,
        transitionTimingFunction: "ease-out",
      }}
    >
      {children}
    </div>
  );
}