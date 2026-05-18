import { EaosStateChip } from "./EaosStateChip";
import {
  DEFAULT_BOTTOM_STRIP_LABEL,
  KERNEL_POSTURE_LABEL,
  NOT_CONNECTED_DATA_LABEL,
  NOT_CONNECTED_DATA_NOTE,
  NOT_CONNECTED_DATA_PREFIX,
  SHELL_POSTURE_PREFIX,
} from "./state-labels";

export interface EaosPostureStripProps {
  variant: "eaos" | "kernel";
  // When a LIVE or APPROVAL REQUIRED context applies, this prop pins those
  // labels alongside the default posture. LET-164 §3 forbids hiding them.
  liveActive?: boolean;
  approvalActive?: boolean;
  // Audit/correlation hint shown on the right of the strip. Free-form
  // identifier produced by the shell (never a raw secret).
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
      aria-label="Posture and live state"
      data-testid="eaos-posture-strip"
      data-eaos-data-connected={isKernel ? "true" : "false"}
      data-eaos-live-active={liveActive ? "true" : "false"}
      data-eaos-approval-active={approvalActive ? "true" : "false"}
      className="flex h-9 w-full items-center gap-2 border-t border-border bg-background/95 px-3 text-[11px] text-muted-foreground backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      {isKernel ? (
        <EaosStateChip label="BACKEND-BACKED" prefix="Kernel/Admin" title={KERNEL_POSTURE_LABEL} />
      ) : (
        <>
          <EaosStateChip label={DEFAULT_BOTTOM_STRIP_LABEL} prefix={SHELL_POSTURE_PREFIX} />
          <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
          <span className="uppercase tracking-wide">{NOT_CONNECTED_DATA_NOTE}</span>
        </>
      )}
      {liveActive ? <EaosStateChip label="LIVE" /> : null}
      {approvalActive ? <EaosStateChip label="APPROVAL REQUIRED" /> : null}
      <span className="ml-auto truncate" data-testid="eaos-posture-strip-audit">
        {auditId ? `Audit · ${auditId}` : "Audit · n/a"}
      </span>
    </footer>
  );
}
