import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/** Shared disclosure treatment for GitHub connection settings. */
export function GitHubSettingsDisclosure({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="group/disclosure text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm py-2 font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className="size-4 shrink-0 transition-transform group-open/disclosure:rotate-90" />
        {title}
      </summary>
      <div className="space-y-4 pb-2 pt-3">{children}</div>
    </details>
  );
}
