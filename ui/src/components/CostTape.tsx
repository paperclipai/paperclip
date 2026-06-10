import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * GLASSHOUSE cost tape — mono tabular money where each digit flashes teal
 * (~420ms) when it changes, so the figure visibly ticks. `tabular-nums` keeps
 * every glyph the same width so the tape never reflows. See DESIGN.md → "The
 * cost tape". Feed it a fully-formatted string (e.g. "$12.04").
 */
export function CostTape({ text, className }: { text: string; className?: string }) {
  const prev = useRef(text);
  const [flash, setFlash] = useState<Set<number>>(new Set());
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (text === prev.current) return;
    const a = prev.current;
    const b = text;
    // Right-align the compare so the cents flash even as the integer part grows.
    const changed = new Set<number>();
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      if (a[a.length - 1 - i] !== b[b.length - 1 - i]) changed.add(b.length - 1 - i);
    }
    prev.current = text;
    setFlash(changed);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFlash(new Set()), 460);
  }, [text]);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  return (
    <span className={cn("font-mono tabular-nums", className)}>
      {text.split("").map((ch, i) => (
        <span key={i} className={cn("cost-digit", flash.has(i) && "cost-digit-flash")}>
          {ch}
        </span>
      ))}
    </span>
  );
}
