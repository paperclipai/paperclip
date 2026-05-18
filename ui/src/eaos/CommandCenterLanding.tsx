import { Link } from "@/lib/router";
import { EaosStateChip } from "./EaosStateChip";
import { EAOS_PRIMARY_NAV } from "./nav-zones";
import {
  NOT_CONNECTED_DATA_LABEL,
  NOT_CONNECTED_DATA_NOTE,
  NOT_CONNECTED_DATA_PREFIX,
  SHELL_POSTURE_LABEL,
  SHELL_POSTURE_PREFIX,
} from "./state-labels";

// `/eaos` index landing. Skeleton-only in this slice — counts stub to 0, no
// API calls. Per LET-187 the shell layer carries the `Shell · BACKEND-BACKED`
// chip, while every card's data layer carries `Data · PREVIEW · Not connected`
// because the LET-182 read-model contract is not yet wired. The previous
// version labeled cards BACKEND-BACKED which the LET-183 Product Designer
// REQUEST_CHANGES flagged as a semantic-trust violation.
export function CommandCenterLanding() {
  return (
    <section
      aria-labelledby="eaos-command-center-title"
      className="flex flex-col gap-5"
      data-testid="eaos-command-center-landing"
      data-eaos-data-connected="false"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2" data-testid="eaos-command-center-posture">
            <EaosStateChip label={SHELL_POSTURE_LABEL} prefix={SHELL_POSTURE_PREFIX} />
            <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {NOT_CONNECTED_DATA_NOTE}
            </span>
          </div>
          <h1 id="eaos-command-center-title" className="text-2xl font-semibold tracking-tight">
            Command Center
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Role-aware landing dashboard for active missions, blocked work, approvals required, and
            recent final deliveries. Cards are stubbed at zero until the LET-182 read-model contract
            wires them.
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="eaos-landing-grid">
        {EAOS_PRIMARY_NAV.filter((zone) => zone.path !== "/eaos").map((zone) => (
          <article
            key={zone.id}
            className="flex flex-col gap-2 rounded-md border border-border bg-card p-4 shadow-none"
            aria-labelledby={`eaos-card-${zone.id}-title`}
            data-testid={`eaos-landing-card-${zone.id}`}
            data-eaos-data-connected="false"
          >
            <div className="flex items-start justify-between gap-2">
              <h2 id={`eaos-card-${zone.id}-title`} className="text-sm font-medium text-foreground">
                {zone.label}
              </h2>
              <EaosStateChip
                label={NOT_CONNECTED_DATA_LABEL}
                prefix={NOT_CONNECTED_DATA_PREFIX}
              />
            </div>
            <p className="text-xs text-muted-foreground">{zone.description}</p>
            <p className="text-xs italic text-muted-foreground">{NOT_CONNECTED_DATA_NOTE}.</p>
            <div className="mt-auto pt-2">
              <Link
                to={zone.path}
                className="inline-flex items-center text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                View {zone.label}
              </Link>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
