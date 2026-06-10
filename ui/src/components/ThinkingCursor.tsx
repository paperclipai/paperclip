import { cn } from "@/lib/utils";

/**
 * GLASSHOUSE thinking cursor — a live blinking terminal block (running-teal,
 * 1.05s) that ends a working entity's run-stream line, so you watch the agent
 * actively composing. Render it inline at the end of the last streaming line.
 * See DESIGN.md → "Thinking cursor".
 */
export function ThinkingCursor({ className }: { className?: string }) {
  return <span className={cn("thinking-cursor", className)} aria-hidden="true" />;
}
