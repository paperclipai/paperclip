import { AlertTriangle, OctagonX } from "lucide-react";
import { useBoardCapabilities } from "../hooks/useFeatures";
import { useCompany } from "../context/CompanyContext";

/**
 * Layout-level standing banner for the selected company (spec §5.4):
 * `grace` → warning + action link, `blocked` → error + action link.
 * Renders nothing for `active`, unknown companies, or while/after a failed
 * capabilities fetch — the standing gate is enforced server-side, the banner
 * only warns (fail-safe: unknown = active).
 */
export function CompanyStandingBanner() {
  const { selectedCompanyId } = useCompany();
  const { data: boardAccess } = useBoardCapabilities();

  const standing = selectedCompanyId
    ? boardAccess?.capabilities?.companyStandings?.[selectedCompanyId]
    : undefined;
  if (!standing || (standing.status !== "grace" && standing.status !== "blocked")) return null;

  const blocked = standing.status === "blocked";
  const Icon = blocked ? OctagonX : AlertTriangle;
  const fallbackMessage = blocked
    ? "This company is blocked from starting new agent runs."
    : "This company needs attention.";

  return (
    <div
      data-testid="company-standing-banner"
      data-standing={standing.status}
      role={blocked ? "alert" : "status"}
      className={
        blocked
          ? "border-b border-red-300/60 bg-red-50 text-red-950 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-100"
          : "border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100"
      }
    >
      <div className="flex items-center gap-3 px-3 py-2 text-sm">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          {standing.message?.trim() || fallbackMessage}
          {standing.actionUrl ? (
            <>
              {" "}
              <a
                href={standing.actionUrl}
                className="font-semibold underline underline-offset-2 hover:opacity-80"
              >
                Resolve now
              </a>
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}
