import { t, useTranslation } from "@/i18n";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Upload } from "lucide-react";
import { FILE_DROP_TARGET_SELECTOR } from "../../lib/file-drop-target";

interface DropTarget {
  element: HTMLSpanElement;
  reset: () => void;
}

const targets: DropTarget[] = [];

function activeTarget() {
  const unavailable = '[inert], [hidden], [aria-hidden="true"]';
  const dialogs = Array.from(document.querySelectorAll('[aria-modal="true"], [role="alertdialog"], dialog[open], [data-slot="dialog-content"], [data-slot="sheet-content"]'))
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
  useTranslation("task-components");
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

    const owns = (event: DragEvent) => activeTarget() === target
      && !(event.target instanceof Element && event.target.closest(FILE_DROP_TARGET_SELECTOR))
      && Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => {
      if (!owns(event)) { reset(); return; }
      event.preventDefault();
      if (!current.current.enabled) return;
      depth += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!owns(event)) { reset(); return; }
      event.preventDefault();
      event.dataTransfer!.dropEffect = current.current.enabled ? "copy" : "none";
      setDragging(current.current.enabled);
    };
    const leave = (event: DragEvent) => {
      if (!owns(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0 || (!event.relatedTarget && event.target === document.documentElement)) reset();
    };
    const drop = (event: DragEvent) => {
      const owned = owns(event);
      reset();
      if (!owned) return;
      event.preventDefault();
      event.stopPropagation();
      if (!current.current.enabled) return;
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
          <p className="text-xl font-semibold">{t("task-components:sentence_1ab1b095c1ed")}</p>
          <p className="text-sm text-muted-foreground">{newTask ? t("task-chat-ui:dropNewTask") : t("task-chat-ui:dropMessage")}</p>
        </div>
      </div>, document.body,
    ) : null}
  </>;
}
