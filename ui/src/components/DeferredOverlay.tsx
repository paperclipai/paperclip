import { t, useTranslation } from "@/i18n";
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
  useTranslation("task-components");
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined}>
      <DialogTitle>{failed ? t("task-components:couldnTOpen_70f03841", { value1: title.toLowerCase() }) : t("task-components:loading_638c84f3", { value1: title.toLowerCase() })}</DialogTitle>
      {failed
        ? <p className="text-sm text-muted-foreground">{t("task-components:closeThisWindowToKeepWorkingReload_acc29aea")}</p>
        : <PaperclipLoading className="min-h-0" />}
      <div className="flex justify-end"><Button variant="outline" onClick={onClose}>{failed ? t("task-components:close_7d9eb7ac") : t("task-components:cancel_19766ed6")}</Button></div>
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
  useTranslation("task-components");
  const [activated, setActivated] = useState(requested);
  if (requested && !activated) setActivated(true);
  if (!requested && !activated) return null;
  return <OverlayErrorBoundary requested={requested} title={title} onClose={onClose}>
    <Suspense fallback={requested ? <OverlayNotice title={title} onClose={onClose} /> : null}>{children}</Suspense>
  </OverlayErrorBoundary>;
}
