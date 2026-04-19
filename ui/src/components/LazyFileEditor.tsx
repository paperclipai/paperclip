import { lazy, Suspense, type ComponentProps } from "react";

const FileEditor = lazy(() => import("./FileEditor").then((m) => ({ default: m.FileEditor })));

type FileEditorProps = ComponentProps<typeof FileEditor>;

/**
 * Lazy-loaded wrapper around FileEditor.
 * CodeMirror bundles are only fetched when this component mounts,
 * keeping the initial bundle small.
 */
export function LazyFileEditor(props: FileEditorProps) {
  return (
    <Suspense
      fallback={
        <div className="flex h-40 items-center justify-center rounded-md border text-sm text-muted-foreground">
          Loading editor…
        </div>
      }
    >
      <FileEditor {...props} />
    </Suspense>
  );
}
