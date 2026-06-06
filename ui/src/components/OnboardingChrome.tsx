import { X } from "lucide-react";
import { cn } from "../lib/utils";
import { AsciiArtAnimation } from "./AsciiArtAnimation";

interface OnboardingChromeProps {
  children: React.ReactNode;
  /** Show the animated right-side panel. Defaults to true (the entry-point look). */
  showAnimation?: boolean;
  /** If provided, renders a close button in the top-left that calls this. */
  onClose?: () => void;
  /** Optional className override for the outer container (rare). */
  className?: string;
}

/**
 * Shared chrome for the onboarding flow. Mirrors the classic wizard's split
 * layout — full-viewport background, left content pane, animated ASCII pane on
 * the right (md+). Used by both the Coach entry page and the Coach chat so the
 * onboarding experience feels continuous.
 */
export function OnboardingChrome({
  children,
  showAnimation = true,
  onClose,
  className,
}: OnboardingChromeProps) {
  return (
    <div className={cn("fixed inset-0 z-40 bg-background", className)}>
      <div className="absolute inset-0 flex">
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 left-4 z-10 rounded-sm p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
            <span className="sr-only">Close</span>
          </button>
        ) : null}

        <div
          className={cn(
            "w-full flex flex-col overflow-y-auto transition-[width] duration-500 ease-in-out",
            showAnimation ? "md:w-1/2" : "md:w-full",
          )}
        >
          {children}
        </div>

        <div
          className={cn(
            "hidden md:block overflow-hidden bg-[#1d1d1d] transition-[width,opacity] duration-500 ease-in-out",
            showAnimation ? "w-1/2 opacity-100" : "w-0 opacity-0",
          )}
        >
          <AsciiArtAnimation />
        </div>
      </div>
    </div>
  );
}
