import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

function detectPlatform(): string {
  if (typeof navigator === "undefined") return "";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform || navigator.userAgent || "";
}

/** Platform-appropriate label for the Cmd/Ctrl modifier ("⌘" on Apple
 *  platforms, "Ctrl" elsewhere). Pass `platform` explicitly in tests. */
export function getModKeyLabel(platform?: string): "⌘" | "Ctrl" {
  return /Mac|iPhone|iPad|iPod/.test(platform ?? detectPlatform()) ? "⌘" : "Ctrl";
}

/** Compact label for a Cmd/Ctrl+key shortcut: "⌘S" on Apple platforms,
 *  "Ctrl+S" (with separator) elsewhere. */
export function modComboLabel(key: string, platform?: string): string {
  const mod = getModKeyLabel(platform);
  return mod === "⌘" ? `⌘${key}` : `Ctrl+${key}`;
}

/** Compact label for the Cmd/Ctrl+Enter submit shortcut: "⌘↵" or "Ctrl+↵". */
export function modEnterLabel(platform?: string): string {
  return modComboLabel("↵", platform);
}

/**
 * Inline keyboard-shortcut hint badge, sized to sit inside buttons next to
 * their label. Decorative: hidden from assistive tech — expose the shortcut
 * via `aria-keyshortcuts` on the interactive element instead.
 */
export function Kbd({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        "pointer-events-none inline-flex items-center rounded bg-foreground/10 px-1 font-medium text-(length:--text-nano)",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
