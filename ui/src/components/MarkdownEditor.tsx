import { Suspense, forwardRef, lazy } from "react";

import { cn } from "../lib/utils";
import type { MarkdownEditorProps, MarkdownEditorRef } from "./MarkdownEditorImpl";

// Re-export the editor's public types so existing consumers keep importing them
// from "./MarkdownEditor" unchanged. Type-only re-exports are erased at build,
// so they do not pull the heavy implementation onto the critical path.
export type { MentionOption, MarkdownEditorRef, MarkdownEditorProps } from "./MarkdownEditorImpl";

// `@mdxeditor/editor` (~4.4 MB of source) plus `lexical` are the single largest
// contributor to the app's JavaScript. Loading the real editor lazily means
// those libraries (and the mdxeditor stylesheet) are fetched on demand — the
// first time any composer, inline editor, or dialog actually renders an editor
// — instead of shipping on every route's critical path. Every
// existing `MarkdownEditor` consumer picks this up transparently.
const MarkdownEditorImpl = lazy(() =>
  import("./MarkdownEditorImpl").then((module) => ({ default: module.MarkdownEditor })),
);

function MarkdownEditorFallback({
  bordered,
  contentClassName,
}: Pick<MarkdownEditorProps, "bordered" | "contentClassName">) {
  // Reserve roughly a single input row so swapping in the real editor does not
  // shift surrounding layout while the chunk loads.
  return (
    <div
      aria-hidden
      className={cn(
        "min-h-10 rounded-md",
        bordered === false ? undefined : "border border-input bg-transparent",
        contentClassName,
      )}
    />
  );
}

export const MarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(
  function MarkdownEditor(props, ref) {
    return (
      <Suspense
        fallback={
          <MarkdownEditorFallback bordered={props.bordered} contentClassName={props.contentClassName} />
        }
      >
        <MarkdownEditorImpl {...props} ref={ref} />
      </Suspense>
    );
  },
);
