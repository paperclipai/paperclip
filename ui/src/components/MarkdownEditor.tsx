import {
  forwardRef,
  lazy,
  Suspense,
  type ComponentProps,
} from "react";
import type {
  MarkdownEditorProps,
  MarkdownEditorRef,
  MentionOption,
} from "./MarkdownEditorImpl";

const MarkdownEditorImpl = lazy(() =>
  import("./MarkdownEditorImpl").then((module) => ({
    default: module.MarkdownEditor,
  })),
);

export type { MarkdownEditorProps, MarkdownEditorRef, MentionOption };

/**
 * Lightweight boundary around the rich MDX editor.
 *
 * The editor is several megabytes of parser/editor code and is unnecessary
 * until an editable composer is actually rendered. Keeping this boundary small
 * prevents read-only and list routes from paying that startup cost.
 */
export const MarkdownEditor = forwardRef<
  MarkdownEditorRef,
  ComponentProps<typeof MarkdownEditorImpl>
>(function MarkdownEditor(props, ref) {
  return (
    <Suspense
      fallback={
        <div
          className="min-h-20 animate-pulse rounded-md border bg-muted/30"
          aria-label="Loading editor"
        />
      }
    >
      <MarkdownEditorImpl {...props} ref={ref} />
    </Suspense>
  );
});
