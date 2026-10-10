import { useEffect, useRef, useState } from "react";
import type { ComputerViewer } from "@paperclipai/shared";
import { LoaderCircle, Monitor } from "lucide-react";
import { computersApi } from "@/api/computers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ComputerPanelProps = { issueId: string; environmentId: string; active?: boolean };

export function TaskComputerPanel(props: ComputerPanelProps) {
  // A connection belongs to one task/environment. A new scope gets new state,
  // so a late response can only retire its old owner, never install its viewer.
  return <ComputerConnection key={`${props.issueId}:${props.environmentId}`} {...props} />;
}

function ComputerConnection({ issueId, environmentId, active = true }: ComputerPanelProps) {
  const [viewer, setViewer] = useState<ComputerViewer | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<ComputerViewer | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const mounted = useRef(true);
  const connectPending = useRef(false);
  const [port, setPort] = useState("5173");
  const [previewPending, setPreviewPending] = useState(false);

  async function openPreview() {
    const previewWindow = window.open("about:blank", "_blank");
    if (!previewWindow) { setError("Allow a new tab to open the preview."); return; }
    previewWindow.opener = null;
    setPreviewPending(true);
    setError(null);
    try {
      const result = await computersApi.preview(issueId, environmentId, Number(port));
      if (mounted.current) previewWindow.location.replace(result.url);
      else previewWindow.close();
    } catch (cause) {
      previewWindow.close();
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not open the preview.");
    } finally { if (mounted.current) setPreviewPending(false); }
  }

  function release(view: ComputerViewer) {
    void computersApi.disconnect(issueId, environmentId, view.owner).catch(() => {
      // The server's bounded presence deadline also releases lost viewers.
    });
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const previous = current.current;
      current.current = null;
      if (previous) release(previous);
    };
  }, [issueId, environmentId]);

  async function connect() {
    if (connectPending.current) return;
    connectPending.current = true;
    setConnecting(true);
    setError(null);
    try {
      const result = await computersApi.connect(issueId, environmentId);
      if (!mounted.current) {
        release(result);
        return;
      }
      current.current = result;
      setViewer(result);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not connect to the computer.");
    } finally {
      connectPending.current = false;
      if (mounted.current) setConnecting(false);
    }
  }

  useEffect(() => {
    if (!viewer) return;
    let disposed = false;
    let pending = false;
    const renew = async () => {
      const frame = frameRef.current;
      if (pending || !active || document.visibilityState === "hidden" || !frame || !frame.getClientRects().length ||
        (frame.checkVisibility && !frame.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))) return;
      pending = true;
      try {
        const next = await computersApi.presence(issueId, environmentId, viewer.owner);
        if (disposed || !mounted.current) {
          // It may have renewed the old owner while this pane was closing.
          if (current.current?.owner.ownerId !== next.owner.ownerId) release(next);
          return;
        }
        current.current = next;
        setViewer(next);
      } catch (cause) {
        if (!disposed) {
          const previous = current.current;
          current.current = null;
          setViewer(null);
          if (previous) release(previous);
          setError(cause instanceof Error ? cause.message : "The connection ended. Connect to try again.");
        }
      } finally { pending = false; }
    };
    const timer = setInterval(() => void renew(), 30_000);
    document.addEventListener("visibilitychange", renew);
    // A hidden pane may have outlived its server hold. Revalidate immediately
    // when it becomes active, before waiting for the next periodic renewal.
    void renew();
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", renew);
    };
  }, [issueId, environmentId, viewer?.owner.ownerId, active]);

  useEffect(() => {
    if (!viewer) return;
    const expiresAt = Date.parse(viewer.expiresAt);
    const timer = setTimeout(() => {
      if (current.current !== viewer) return;
      current.current = null;
      setViewer(null);
      setError("The connection expired. Connect to try again.");
      release(viewer);
    }, Math.max(0, Number.isFinite(expiresAt) ? expiresAt - Date.now() : 0));
    return () => clearTimeout(timer);
  }, [viewer]);

  const desktop = viewer ? <iframe
    ref={frameRef}
    title="Agent computer"
    src={viewer.viewerUrl}
    className="h-full w-full border-0"
    referrerPolicy="no-referrer"
    allow="clipboard-read; clipboard-write; fullscreen; autoplay"
  /> : <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
    <Monitor className="size-6 text-muted-foreground" />
    <p className="text-sm text-muted-foreground">Open the shared computer to see and control your agents’ desktop.</p>
    <Button onClick={() => void connect()} disabled={connecting}>
      {connecting && <LoaderCircle className="size-4 animate-spin" />}
      {connecting ? "Connecting…" : "Connect"}
    </Button>
  </div>;
  return <div className="flex h-full min-h-0 flex-col">
    <div className="min-h-0 flex-1">{desktop}</div>
    <div className="flex shrink-0 flex-col gap-2 border-t p-3">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <form className="flex items-center gap-2" onSubmit={event => { event.preventDefault(); void openPreview(); }}>
        <label htmlFor={`preview-port-${environmentId}`} className="text-sm text-muted-foreground">Port</label>
        <Input id={`preview-port-${environmentId}`} type="number" min="1024" max="65535" value={port}
          className="min-w-0 flex-1" onChange={event => setPort(event.target.value)} />
        <Button type="submit" variant="outline" disabled={previewPending || !port}>Open preview</Button>
      </form>
    </div>
  </div>;
}
