import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Upload } from "lucide-react";

/** The target can be the host frame when its tab header is rendered by a portal. */
export function ArtifactDropzone({ children, onUpload, enabled = true, target }: {
  children: ReactNode;
  onUpload: (files: File[]) => void;
  enabled?: boolean;
  target?: HTMLElement | null;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const uploadRef = useRef(onUpload);
  uploadRef.current = onUpload;
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const element = target ?? rootRef.current;
    setDragging(false);
    if (!enabled || !element) return;
    let depth = 0;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.stopPropagation();
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) uploadRef.current(files);
    };
    element.addEventListener("dragenter", enter);
    element.addEventListener("dragover", over);
    element.addEventListener("dragleave", leave);
    element.addEventListener("drop", drop);
    return () => {
      element.removeEventListener("dragenter", enter);
      element.removeEventListener("dragover", over);
      element.removeEventListener("dragleave", leave);
      element.removeEventListener("drop", drop);
    };
  }, [enabled, target]);

  const overlay = dragging ? (
    <div data-artifact-drop-overlay role="status" className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 border-2 border-dashed border-primary bg-background/95 px-6 text-center">
      <Upload aria-hidden="true" className="size-6 text-primary" />
      <p className="text-sm font-medium">Drop files to add them to this task</p>
    </div>
  ) : null;
  return (
    <section ref={rootRef} aria-label={enabled ? "Artifact uploads" : undefined} className="relative h-full min-h-0">
      {children}
      {target && overlay ? createPortal(overlay, target) : overlay}
    </section>
  );
}
