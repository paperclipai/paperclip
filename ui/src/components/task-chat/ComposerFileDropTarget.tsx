import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Upload } from "lucide-react";

interface DropTarget {
  element: HTMLSpanElement;
  reset: () => void;
}

// A new-task dialog can open over an existing task. Only its composer should
// receive the drop, even while it is temporarily unable to accept attachments.
const targets: DropTarget[] = [];

function activeTarget() {
  const unavailable = '[inert], [hidden], [aria-hidden="true"]';
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
    .filter(dialog => !dialog.closest(unavailable));
  const dialog = dialogs.at(-1);
  return targets.findLast(target => target.element.isConnected
    && !target.element.parentElement?.closest(unavailable)
    && (!dialog || dialog.contains(target.element)));
}

export function ComposerFileDropTarget({
  enabled,
  newTask = false,
  onFiles,
}: {
  enabled: boolean;
  newTask?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const marker = useRef<HTMLSpanElement>(null);
  const current = useRef({ enabled, onFiles });
  const [dragging, setDragging] = useState(false);
  useLayoutEffect(() => { current.current = { enabled, onFiles }; });

  useEffect(() => {
    if (!enabled) setDragging(false);
  }, [enabled]);

  useEffect(() => {
    let depth = 0;
    const reset = () => { depth = 0; setDragging(false); };
    const target: DropTarget = { element: marker.current!, reset };
    targets.push(target);
    targets.forEach(item => item.reset());

    const accepts = (event: DragEvent) => activeTarget() === target
      && current.current.enabled && Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!accepts(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0 || (!event.relatedTarget && event.target === document.documentElement)) reset();
    };
    const drop = (event: DragEvent) => {
      const accepted = accepts(event);
      reset();
      if (!accepted) return;
      // Capture before the rich editor and dialog handlers to attach each file once.
      event.preventDefault();
      event.stopPropagation();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) current.current.onFiles(files);
    };
    document.addEventListener("dragenter", enter, true);
    document.addEventListener("dragover", over, true);
    document.addEventListener("dragleave", leave, true);
    document.addEventListener("drop", drop, true);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      targets.splice(targets.indexOf(target), 1);
      document.removeEventListener("dragenter", enter, true);
      document.removeEventListener("dragover", over, true);
      document.removeEventListener("dragleave", leave, true);
      document.removeEventListener("drop", drop, true);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, []);

  return <>
    <span ref={marker} hidden />
    {dragging && enabled ? createPortal(
      <div data-testid="composer-file-drop-overlay" role="status"
        className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-(--blur-1px)">
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-primary bg-primary/5 text-foreground">
          <Upload className="h-10 w-10 text-primary" aria-hidden />
          <p className="text-xl font-semibold">Drop files to attach</p>
          <p className="text-sm text-muted-foreground">{newTask ? "Add images and files to your new task" : "Add images and files to your message"}</p>
        </div>
      </div>, document.body,
    ) : null}
  </>;
}
