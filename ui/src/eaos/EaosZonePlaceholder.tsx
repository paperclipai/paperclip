import { EaosStateChip } from "./EaosStateChip";
import {
  NOT_CONNECTED_DATA_LABEL,
  NOT_CONNECTED_DATA_NOTE,
  NOT_CONNECTED_DATA_PREFIX,
  SHELL_POSTURE_LABEL,
  SHELL_POSTURE_PREFIX,
} from "./state-labels";

export interface EaosZonePlaceholderProps {
  title: string;
  description: string;
}

// Read-only placeholder used by every primary-nav zone in this slice. No
// LIVE/APPLY/APPROVE controls — those are introduced in subsequent slices
// once LET-182 has a typed read-model contract.
//
// LET-187 fix: dual-label the posture so the shell-layer trust (the route
// shell IS backend-backed) is honest about the data layer being preview /
// not-connected. The previous single BACKEND-BACKED chip was flagged by
// LET-183 Product Designer REQUEST_CHANGES.
export function EaosZonePlaceholder({ title, description }: EaosZonePlaceholderProps) {
  return (
    <section
      aria-labelledby="eaos-zone-title"
      className="flex flex-col gap-3"
      data-testid="eaos-zone-placeholder"
      data-eaos-data-connected="false"
    >
      <div className="flex flex-wrap items-center gap-2" data-testid="eaos-zone-posture">
        <EaosStateChip label={SHELL_POSTURE_LABEL} prefix={SHELL_POSTURE_PREFIX} />
        <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {NOT_CONNECTED_DATA_NOTE}
        </span>
      </div>
      <h1 id="eaos-zone-title" className="text-2xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
      <div className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
        {NOT_CONNECTED_DATA_NOTE}. Subsequent EAOS-FE slices will wire this zone to the read-model
        contract.
      </div>
    </section>
  );
}
