import { Clock4, FileSearch } from "lucide-react";
import { EaosStateChip } from "./EaosStateChip";

// LET-503 (LET-502 contract §3/§4) — calm footer strip. The default
// `Shell · BACKEND-BACKED` + `Data · PREVIEW · Not connected` dual chip
// pattern was visual noise on every page; it now appears only when a
// `LIVE` or `APPROVAL REQUIRED` context applies. Audit/session breadcrumb
// stays on the right so operators can correlate the session without
// hunting through a kernel page.

export interface EaosPostureStripProps {
  variant: "eaos" | "kernel";
  // Pinned only when an actually-LIVE or actually-pending-approval context
  // applies. The shell does not assert these on every render anymore.
  liveActive?: boolean;
  approvalActive?: boolean;
  // Free-form correlation identifier produced by the shell (never a raw
  // secret). When omitted, the strip shows `Audit · n/a`.
  auditId?: string;
}

export function EaosPostureStrip({
  variant,
  liveActive = false,
  approvalActive = false,
  auditId,
}: EaosPostureStripProps) {
  const isKernel = variant === "kernel";

  return (
    <footer
      role="contentinfo"
      aria-label="Session and live state"
      data-testid="eaos-posture-strip"
      data-eaos-live-active={liveActive ? "true" : "false"}
      data-eaos-approval-active={approvalActive ? "true" : "false"}
      className="flex h-8 w-full items-center gap-2 border-t border-border bg-background/95 px-3 text-[11px] text-muted-foreground backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      {liveActive ? <EaosStateChip label="LIVE" /> : null}
      {approvalActive ? <EaosStateChip label="APPROVAL REQUIRED" /> : null}
      <span
        className="ml-auto inline-flex items-center gap-1.5 truncate"
        data-testid="eaos-posture-strip-audit"
      >
        <FileSearch aria-hidden="true" className="h-3 w-3" />
        <span className="truncate">{auditId ? `Audit · ${auditId}` : "Audit · n/a"}</span>
        <span aria-hidden="true" className="mx-1 h-3 border-l border-border" />
        <Clock4 aria-hidden="true" className="h-3 w-3" />
        <span className="hidden sm:inline">{isKernel ? "Kernel session" : "Operator session"}</span>
      </span>
    </footer>
  );
}
