import { ExternalLink, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function isSafeLocalPreviewUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

type RuntimePreviewFrameProps = {
  url: string | null | undefined;
  title?: string;
  className?: string;
  frameClassName?: string;
};

/**
 * Embeds a running local dev service in a sandboxed iframe with an "open in tab"
 * and a "reload" control. Reload remounts the iframe (bumped key) rather than
 * poking contentWindow, which is the simplest reliable refresh. Only renders for
 * http(s) URLs; anything else (or a stopped service) shows nothing.
 */
export function RuntimePreviewFrame({ url, title, className, frameClassName }: RuntimePreviewFrameProps) {
  const [reloadKey, setReloadKey] = useState(0);
  if (!isSafeLocalPreviewUrl(url)) return null;
  const safeUrl = url as string;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-xs text-muted-foreground" title={safeUrl}>
          {title ? `${title} · ` : ""}{safeUrl}
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            <RotateCcw className="size-3.5" />
            Reload
          </Button>
          <Button asChild type="button" variant="outline" size="sm">
            <a href={safeUrl} target="_blank" rel="noreferrer noopener">
              <ExternalLink className="size-3.5" />
              Open in tab
            </a>
          </Button>
        </div>
      </div>
      <iframe
        key={reloadKey}
        src={safeUrl}
        title={title ?? safeUrl}
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
        className={cn(
          "h-[36rem] max-h-[70vh] w-full rounded-md border border-border bg-background",
          frameClassName,
        )}
      />
    </div>
  );
}
