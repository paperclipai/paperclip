import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** Tracks the content viewport so sidebar resizing never covers navigation. */
export function AgentConfigSaveBar({ dirty, saving, savedVersion = 0, onDiscard, onSave }: {
  dirty: boolean;
  saving: boolean;
  savedVersion?: number;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<{ left: number; width: number } | null>(null);
  const lastSave = useRef(savedVersion);
  const [pendingSuccess, setPendingSuccess] = useState(false);
  const [success, setSuccess] = useState<"idle" | "entering" | "holding" | "exiting">("idle");
  const showSuccess = success !== "idle" && !dirty && !saving;
  const visible = dirty || saving || (showSuccess && success !== "exiting");
  useEffect(() => {
    if (savedVersion === lastSave.current) return;
    lastSave.current = savedVersion;
    setPendingSuccess(true);
  }, [savedVersion]);
  useEffect(() => {
    if (pendingSuccess && !dirty && !saving) {
      setPendingSuccess(false);
      setSuccess("entering");
    } else if (dirty || saving) setSuccess("idle");
  }, [dirty, saving, pendingSuccess]);
  useEffect(() => {
    if (success !== "entering") return;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const settle = () => { if (media?.matches) setSuccess("holding"); };
    settle();
    media?.addEventListener("change", settle);
    return () => media?.removeEventListener("change", settle);
  }, [success]);
  useEffect(() => {
    if (success !== "holding") return;
    // Start the two-second reading interval only after the label arrives.
    const timer = setTimeout(() => setSuccess("exiting"), 2000);
    return () => clearTimeout(timer);
  }, [success]);
  useLayoutEffect(() => {
    const main = anchor.current?.closest("main") ?? anchor.current?.parentElement;
    if (!main) return;
    const measure = () => {
      const rect = main.getBoundingClientRect();
      setBounds({ left: rect.left, width: rect.width });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(main);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  return <div ref={anchor}>
    <footer aria-label="Unsaved agent changes" aria-hidden={!visible} inert={!visible}
      data-visible={visible} style={bounds ?? undefined}
      className="agent-config-save-bar flex flex-wrap items-center justify-between gap-3">
      <p role="status" className="agent-save-status text-xs text-muted-foreground">
        <span aria-hidden={showSuccess} className={showSuccess ? "agent-save-status-out flex items-center gap-2" : "flex items-center gap-2"}>
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-(--agent-save-dot-unsaved)" />
          {saving ? "Saving changes…" : "Unsaved changes"}
        </span>
        {showSuccess && <span key={savedVersion} className="agent-save-status-in flex items-center gap-2"
          onAnimationEnd={(event) => { if (event.target === event.currentTarget) setSuccess("holding"); }}>
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-(--agent-detail-dot-saved)" />
          Saved changes
        </span>}
      </p>
      <div className="flex gap-2">
        <Button variant="ghost" disabled={!dirty || saving} onClick={onDiscard}>Discard</Button>
        <Button disabled={!dirty || saving} onClick={onSave}>{saving ? "Saving…" : "Save changes"}</Button>
      </div>
    </footer>
  </div>;
}
