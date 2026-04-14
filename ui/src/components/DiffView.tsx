import { useEffect, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface DiffViewProps {
  lines: string[];
  className?: string;
}

export function DiffView({ lines, className }: DiffViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines.length, autoScroll]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(nearBottom);
  }

  return (
    <ScrollArea className={cn("h-full", className)}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto"
      >
        <pre className="p-2 text-xs font-mono leading-relaxed">
          {lines.map((line, i) => {
            const isAdd = line.startsWith("+");
            const isRemove = line.startsWith("-");
            return (
              <div
                key={i}
                className={cn(
                  "px-1 -mx-1 rounded-sm",
                  isAdd && "bg-green-500/15 text-green-700 dark:text-green-400",
                  isRemove && "bg-red-500/15 text-red-700 dark:text-red-400",
                  !isAdd && !isRemove && "text-muted-foreground",
                )}
              >
                {line || "\u00A0"}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </pre>
      </div>
    </ScrollArea>
  );
}
