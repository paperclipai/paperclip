/**
 * LET-326 / LET-352: top-of-page safety posture banner for the read-only
 * Sandbox & runtime dashboard. Three text-first claims are surfaced as
 * separate chips so screen readers announce each disposition individually.
 *
 * The first panel is the LET-352 ADR banner: it states explicitly that this
 * surface is preview-only and that no real container isolation has shipped
 * yet, with a link to the LET-328 buy-vs-build ADR. Operators must not
 * read this dashboard as evidence of live sandbox execution.
 */

import { Link } from "react-router-dom";
import { CircleAlert, ShieldCheck } from "lucide-react";
import { PreviewChip, ReadOnlyChip, StateChip } from "./EaosChips";

export const SANDBOX_PREVIEW_NOTICE =
  "Preview — no real container isolation yet. See ADR LET-328 for the buy-vs-build decision.";

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
    <section className="space-y-3" aria-label="EAOS sandbox safety posture">
      <div
        role="note"
        aria-label="EAOS sandbox preview notice"
        className="flex flex-col gap-2 rounded-xl border border-amber-400/50 bg-amber-500/10 p-4 text-sm text-amber-900 shadow-sm dark:text-amber-200 md:flex-row md:items-center md:justify-between"
      >
        <div className="flex items-start gap-2">
          <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="leading-5">
            <span className="font-semibold">{SANDBOX_PREVIEW_NOTICE}</span>{" "}
            <span className="text-amber-900/80 dark:text-amber-200/80">
              This dashboard reads from the LET-314/LET-323 preview-only sandbox API. It does not
              start containers, perform real egress, or mutate runtime services.
            </span>
          </p>
        </div>
        <Link
          to="/issues/LET-328"
          className="inline-flex shrink-0 items-center gap-1 self-start rounded-md border border-amber-400/60 bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-500/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 dark:text-amber-100 md:self-center"
          aria-label="Open LET-328 sandbox runtime buy-vs-build ADR"
        >
          Open ADR LET-328 →
        </Link>
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-label="EAOS safety posture"
        className="rounded-xl border border-border bg-card/95 p-4 shadow-sm"
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck aria-hidden="true" className="h-4 w-4 text-emerald-500" />
            <span className="text-sm font-medium text-foreground">EAOS Sandbox &amp; runtime dashboard</span>
            <ReadOnlyChip />
            <PreviewChip />
            <StateChip
              label="Stub — no real container isolation"
              tone="warn"
              title="Sandbox provider scaffolding only. No real container/runtime isolation has shipped yet. See ADR LET-328."
            />
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
      </div>
    </section>
  );
}
