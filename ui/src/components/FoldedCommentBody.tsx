import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Ordinary comments should never reach this size. Keep the threshold high so
 * normal long-form updates remain uninterrupted while accidental transcript
 * dumps do not dominate the task thread.
 */
export const LONG_COMMENT_CHARACTER_LIMIT = 20_000;

interface FoldedCommentBodyProps {
  body: string;
  children: (
    visibleBody: string,
    state: { isCollapsed: boolean; isExpanded: boolean },
  ) => ReactNode;
  className?: string;
  /** Contrast override for the toggle when the body sits on a colored bubble. */
  toggleClassName?: string;
}

function previewEnd(body: string) {
  let end = LONG_COMMENT_CHARACTER_LIMIT;
  const finalCodeUnit = body.charCodeAt(end - 1);

  // Avoid ending the preview between a UTF-16 surrogate pair.
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  return end;
}

/**
 * Defers rendering and markdown parsing beyond the first 20,000 characters
 * until the operator explicitly expands an exceptionally large comment.
 */
export function FoldedCommentBody({
  body,
  children,
  className,
  toggleClassName,
}: FoldedCommentBodyProps) {
  const [expandedBody, setExpandedBody] = useState<string | null>(null);
  const shouldFold = body.length > LONG_COMMENT_CHARACTER_LIMIT;
  const expanded = shouldFold && expandedBody === body;
  const visibleBody = shouldFold && !expanded
    ? body.slice(0, previewEnd(body))
    : body;
  const hiddenCharacterCount = body.length - visibleBody.length;
  const isCollapsed = shouldFold && !expanded;

  return (
    <div
      className={cn("min-w-0", className)}
      data-comment-body-folded={isCollapsed ? "true" : "false"}
    >
      {children(visibleBody, { isCollapsed, isExpanded: expanded })}
      {shouldFold ? (
        <div className="mt-2 flex justify-center print:hidden">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpandedBody(expanded ? null : body)}
            className={cn(
              "h-7 px-2 text-xs text-muted-foreground hover:text-foreground",
              toggleClassName,
            )}
          >
            {expanded
              ? "Show less"
              : `Show ${hiddenCharacterCount.toLocaleString()} more characters`}
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
