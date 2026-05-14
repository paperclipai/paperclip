import { CheckCircle, AlertTriangle, ShieldX } from "lucide-react";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * Last verdict from the artifact-evidence gate (BLO-4461).
 * Schema mirror of `issues.last_evidence_verdict` (jsonb column).
 */
export interface EvidenceVerdictRecord {
  verdict: "pass" | "warn" | "block";
  missing: string[];
  evidenceFound: string[];
  unlabeledFallback: boolean;
  evaluatedAt: string;
}

const VERDICT_LABEL: Record<EvidenceVerdictRecord["verdict"], string> = {
  pass: "Evidence ok",
  warn: "Evidence warn",
  block: "Evidence block",
};

const VERDICT_STYLES: Record<EvidenceVerdictRecord["verdict"], string> = {
  pass:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20",
  warn:
    "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20",
  block:
    "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300 hover:bg-rose-500/20",
};

function VerdictIcon({ verdict }: { verdict: EvidenceVerdictRecord["verdict"] }) {
  if (verdict === "pass") return <CheckCircle className="h-3 w-3" aria-hidden />;
  if (verdict === "warn") return <AlertTriangle className="h-3 w-3" aria-hidden />;
  return <ShieldX className="h-3 w-3" aria-hidden />;
}

export function EvidenceBadge({
  verdict,
  className,
  hideLabel = false,
}: {
  verdict: EvidenceVerdictRecord | null | undefined;
  className?: string;
  hideLabel?: boolean;
}) {
  if (!verdict) return null;

  const label = VERDICT_LABEL[verdict.verdict];
  const missing = verdict.missing ?? [];
  const found = verdict.evidenceFound ?? [];
  const ariaSummary =
    missing.length > 0
      ? `${label}; missing ${missing.join(", ")}`
      : label;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium shrink-0 transition-colors",
            VERDICT_STYLES[verdict.verdict],
            className,
          )}
          aria-label={ariaSummary}
        >
          <VerdictIcon verdict={verdict.verdict} />
          {hideLabel ? null : (
            <span>
              {verdict.verdict === "pass"
                ? "Evidence ok"
                : missing.length > 0
                ? `Missing: ${missing[0]}${missing.length > 1 ? ` +${missing.length - 1}` : ""}`
                : label}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="space-y-1 text-xs">
          <div className="font-semibold">
            {label}
            {verdict.unlabeledFallback ? " · unlabeled fallback" : ""}
          </div>
          {missing.length > 0 ? (
            <div>
              <span className="text-muted-foreground">Missing:</span>
              <ul className="mt-0.5 ml-3 list-disc">
                {missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {found.length > 0 ? (
            <div>
              <span className="text-muted-foreground">Found:</span>{" "}
              {found.join(", ")}
            </div>
          ) : null}
          <div>
            <span className="text-muted-foreground">Evaluated:</span>{" "}
            {formatEvaluatedAt(verdict.evaluatedAt)}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function formatEvaluatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
