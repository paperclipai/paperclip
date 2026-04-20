import { lazy, Suspense, forwardRef, type ComponentProps } from "react";
import type { MarkdownSourceEditorRef } from "./MarkdownSourceEditor";

const MarkdownSourceEditor = lazy(() =>
  import("./MarkdownSourceEditor").then((m) => ({
    default: m.MarkdownSourceEditor,
  })),
);

type Props = ComponentProps<typeof MarkdownSourceEditor>;

/**
 * Lazy-loaded wrapper around MarkdownSourceEditor.
 * CodeMirror bundles are only fetched when this component mounts.
 */
export const LazyMarkdownSourceEditor = forwardRef<MarkdownSourceEditorRef, Props>(
  function LazyMarkdownSourceEditor(props, ref) {
    return (
      <Suspense
        fallback={
          <div
            className="flex items-center justify-center rounded-md border border-border text-sm text-muted-foreground"
            style={{ minHeight: props.minHeight ?? "120px" }}
          >
            Loading editor…
          </div>
        }
      >
        <MarkdownSourceEditor ref={ref} {...props} />
      </Suspense>
    );
  },
);
