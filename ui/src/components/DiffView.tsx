import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface DiffViewProps {
  lines: string[];
  className?: string;
  showLineNumbers?: boolean;
}

export function DiffView({ lines, className, showLineNumbers = false }: DiffViewProps) {
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
    <div
      ref={containerRef}
      data-diff-view
      onScroll={handleScroll}
      className={cn("h-full overflow-y-auto", className)}
    >
      <pre className="p-2 text-xs font-mono leading-relaxed">
        {lines.map((line, i) => {
          const isAdd = line.startsWith("+");
          const isRemove = line.startsWith("-");
          return (
            <div
              key={i}
              className={cn(
                "px-1 -mx-1 rounded-sm flex",
                isAdd && "bg-green-500/15 text-green-700 dark:text-green-400",
                isRemove && "bg-red-500/15 text-red-700 dark:text-red-400",
                !isAdd && !isRemove && "text-muted-foreground",
              )}
            >
              {showLineNumbers && (
                <span className="select-none w-8 shrink-0 text-right pr-2 text-muted-foreground/50">
                  {i + 1}
                </span>
              )}
              <span className="flex-1">{line || "\u00A0"}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </pre>
    </div>
  );
}
