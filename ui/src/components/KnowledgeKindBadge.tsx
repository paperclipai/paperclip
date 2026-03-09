import type { KnowledgeItem } from "@paperclipai/shared";
import { cn } from "@/lib/utils";

function kindTone(kind: KnowledgeItem["kind"]) {
  if (kind === "url") return "bg-blue-500/10 text-blue-600 dark:text-blue-400";
  if (kind === "asset") return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
}

export function KnowledgeKindBadge({
  kind,
  className,
}: {
  kind: KnowledgeItem["kind"];
  className?: string;
}) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        kindTone(kind),
        className,
      )}
    >
      {kind}
    </span>
  );
}
