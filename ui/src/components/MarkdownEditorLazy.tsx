import { lazy, Suspense, forwardRef } from "react";
import type { ComponentProps } from "react";

const MarkdownEditorInner = lazy(() =>
  import("./MarkdownEditor").then((m) => ({ default: m.MarkdownEditor })),
);

// Re-export types so consumers don't need to import from the inner module
export type { MentionOption, MarkdownEditorRef } from "./MarkdownEditor";

type MarkdownEditorProps = ComponentProps<typeof MarkdownEditorInner>;

/**
 * Lazy-loaded wrapper around MarkdownEditor.
 * Defers loading @mdxeditor/editor (+ codemirror, etc.) until first render.
 */
export const MarkdownEditor = forwardRef<
  import("./MarkdownEditor").MarkdownEditorRef,
  MarkdownEditorProps
>(function MarkdownEditorLazy(props, ref) {
  return (
    <Suspense
      fallback={
        <div className="rounded-md border border-border bg-transparent px-3 py-2 text-sm text-muted-foreground min-h-[80px]">
          Loading editor…
        </div>
      }
    >
      <MarkdownEditorInner ref={ref} {...props} />
    </Suspense>
  );
});
