import { Component, Suspense, useState, type ReactNode } from "react";
import { captureBrowserException } from "../lib/sentry";
import { PaperclipLoading } from "./AnimatedPaperclipIcon";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

interface DeferredOverlayProps {
  requested: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

function OverlayNotice({ title, onClose, failed = false }: Pick<DeferredOverlayProps, "title" | "onClose"> & { failed?: boolean }) {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined}>
      <DialogTitle>{failed ? `Couldn't open ${title.toLowerCase()}` : `Loading ${title.toLowerCase()}…`}</DialogTitle>
      {failed
        ? <p className="text-sm text-muted-foreground">Close this window to keep working. Reload the page before trying again.</p>
        : <PaperclipLoading className="min-h-0" />}
      <div className="flex justify-end"><Button variant="outline" onClick={onClose}>{failed ? "Close" : "Cancel"}</Button></div>
    </DialogContent>
  </Dialog>;
}

class OverlayErrorBoundary extends Component<DeferredOverlayProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { captureBrowserException(error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return this.props.requested ? <OverlayNotice title={this.props.title} onClose={this.props.onClose} failed /> : null;
  }
}

export function DeferredOverlay({ requested, title, onClose, children }: DeferredOverlayProps) {
  const [activated, setActivated] = useState(requested);
  if (requested && !activated) setActivated(true);
  if (!requested && !activated) return null;
  return <OverlayErrorBoundary requested={requested} title={title} onClose={onClose}>
    <Suspense fallback={requested ? <OverlayNotice title={title} onClose={onClose} /> : null}>{children}</Suspense>
  </OverlayErrorBoundary>;
}
