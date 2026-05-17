/**
 * LET-326: top-of-page safety posture banner for the read-only Sandbox &
 * runtime dashboard. Three text-first claims are surfaced as separate
 * chips so screen readers announce each disposition individually.
 *
 * This component never gates real action — it only labels the surface so
 * an operator knows what this dashboard does and does not do.
 */

import { ShieldCheck } from "lucide-react";
import { PreviewChip, ReadOnlyChip, StateChip } from "./EaosChips";

export interface SafetyPostureBannerProps {
  /**
   * Optional freshness hint. The dashboard fetches with react-query;
   * the parent passes the most recent `generatedAt` from any backend
   * response, or null when no source has reported yet.
   */
  generatedAt?: string | null;
  /** Set when one or more required source calls returned an error. */
  partial?: boolean;
}

export function SafetyPostureBanner({ generatedAt, partial }: SafetyPostureBannerProps) {
  const fresh = generatedAt
    ? new Date(generatedAt).toLocaleString()
    : "Unknown";
  return (
    <section
      aria-label="EAOS safety posture"
      role="status"
      aria-live="polite"
      className="rounded-xl border border-border bg-card/95 p-4 shadow-sm"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck aria-hidden="true" className="h-4 w-4 text-emerald-500" />
          <span className="text-sm font-medium text-foreground">EAOS Sandbox &amp; runtime dashboard</span>
          <ReadOnlyChip />
          <PreviewChip />
          <StateChip
            label="No live sandbox execution"
            tone="info"
            title="Live container start/stop, real egress, and runtime control mutations are not exposed."
          />
          {partial ? (
            <StateChip
              label="Partial source"
              tone="warn"
              title="One or more backend sources returned no data; missing rows shown as Unknown rather than green."
            />
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground" aria-label={`Freshness: ${fresh}`}>
          Snapshot: <span className="font-medium text-foreground">{fresh}</span>
        </p>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        This surface reads from the LET-314/LET-323 preview-only sandbox API and shared run/work-product reads.
        No live sandbox start/stop, no real egress, no runtime service mutation. Missing or unknown fields are
        labeled <span className="font-medium">Unknown</span> rather than treated as green.
      </p>
    </section>
  );
}
