import { useEffect, useRef, useState } from "react";
import type { ComputerViewer } from "@paperclipai/shared";
import { LoaderCircle, Monitor } from "lucide-react";
import { computersApi } from "@/api/computers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function TaskComputerPanel({ issueId, environmentId, active = true }: {
  issueId: string;
  environmentId: string;
  active?: boolean;
}) {
  const [viewer, setViewer] = useState<ComputerViewer | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<ComputerViewer | null>(null);
  const mounted = useRef(true);
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
      previewWindow.location.replace(result.url);
    } catch (cause) {
      previewWindow.close();
      setError(cause instanceof Error ? cause.message : "Could not open the preview.");
    } finally { setPreviewPending(false); }
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const previous = current.current;
      current.current = null;
      if (previous) void computersApi.disconnect(issueId, environmentId, previous.owner).catch(() => {
        // The server's bounded presence deadline also releases lost viewers.
      });
    };
  }, [issueId, environmentId]);

  async function connect() {
    if (connecting) return;
    setConnecting(true);
    setError(null);
    try {
      const result = await computersApi.connect(issueId, environmentId);
      if (!mounted.current) {
        await computersApi.disconnect(issueId, environmentId, result.owner);
        return;
      }
      current.current = result;
      setViewer(result);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not connect to the computer.");
    } finally {
      if (mounted.current) setConnecting(false);
    }
  }

  useEffect(() => {
    if (!viewer) return;
    let disposed = false;
    let pending = false;
    const renew = async () => {
      if (pending || !active || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const next = await computersApi.presence(issueId, environmentId, viewer.owner);
        if (!disposed) {
          current.current = next;
          setViewer(next);
        }
      } catch (cause) {
        if (!disposed) {
          current.current = null;
          setViewer(null);
          setError(cause instanceof Error ? cause.message : "The connection ended. Connect to try again.");
        }
      } finally { pending = false; }
    };
    const timer = setInterval(() => void renew(), 30_000);
    document.addEventListener("visibilitychange", renew);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", renew);
    };
  }, [issueId, environmentId, viewer?.owner.ownerId, active]);

  const desktop = viewer ? <iframe
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
