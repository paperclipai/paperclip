import { useState } from "react";
import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck } from "lucide-react";
import { formatCents } from "../lib/utils";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "Content Approval",
  budget_override_required: "Budget Override",
};

function contentLaneFromPayload(payload?: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const lane = typeof payload.lane === "string" ? payload.lane : null;
  const channel = typeof payload.channel === "string" ? payload.channel : null;
  const category = typeof payload.category === "string" ? payload.category : null;
  const title = typeof payload.title === "string" ? payload.title : null;

  const raw = `${lane ?? ""} ${channel ?? ""} ${category ?? ""} ${title ?? ""}`.toLowerCase();
  if (raw.includes("blog")) return "Blog";
  if (raw.includes("linkedin") || raw.includes("x/") || raw.includes("x post") || raw.includes("social")) return "Social";
  if (raw.includes("outreach") || raw.includes("email")) return "Outreach";
  return null;
}

/** Build a contextual label for an approval, e.g. "Hire Agent: Designer" */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  const base = typeLabel[type] ?? type;
  if (type === "hire_agent" && payload?.name) {
    return `${base}: ${String(payload.name)}`;
  }
  if (type === "approve_ceo_strategy") {
    const lane = contentLaneFromPayload(payload);
    return lane ? `${base} — ${lane}` : base;
  }
  return base;
}

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  budget_override_required: ShieldAlert,
};

export const defaultTypeIcon = ShieldCheck;

function PayloadField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">{label}</span>
      <span>{String(value)}</span>
    </div>
  );
}

function SkillList({ values }: { values: unknown }) {
  if (!Array.isArray(values)) return null;
  const items = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Skills</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Name</span>
        <span className="font-medium">{String(payload.name ?? "—")}</span>
      </div>
      <PayloadField label="Role" value={payload.role} />
      <PayloadField label="Title" value={payload.title} />
      <PayloadField label="Icon" value={payload.icon} />
      {!!payload.capabilities && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Capabilities</span>
          <span className="text-muted-foreground">{String(payload.capabilities)}</span>
        </div>
      )}
      {!!payload.adapterType && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Adapter</span>
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {String(payload.adapterType)}
          </span>
        </div>
      )}
      <SkillList values={payload.desiredSkills} />
    </div>
  );
}

export function CeoStrategyPayload({ payload }: { payload: Record<string, unknown> }) {
  const [showQualityScores, setShowQualityScores] = useState(false);

  const lane = contentLaneFromPayload(payload);
  const channel = typeof payload.channel === "string" ? payload.channel : "—";
  const publishAt = payload.targetPublishAt ? String(payload.targetPublishAt) : "—";

  const summary = typeof payload.summary === "string" ? payload.summary : null;
  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  const draft = typeof payload.draft === "string" ? payload.draft : null;
  const primaryText = summary ?? (plan ? String(plan) : null) ?? (draft ? `${draft.slice(0, 900)}${draft.length > 900 ? "…" : ""}` : null);

  const imageUrl = typeof payload.imageUrl === "string" ? payload.imageUrl : null;
  const imageAlt = typeof payload.imageAlt === "string" ? payload.imageAlt : "Approval image";
  const imageLicense = typeof payload.imageLicense === "string" ? payload.imageLicense : null;

  const metadata = (payload.metadata && typeof payload.metadata === "object")
    ? (payload.metadata as Record<string, unknown>)
    : null;

  const tierClass = lane === "Blog"
    ? "bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30"
    : lane === "Social"
      ? "bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/30"
      : lane === "Outreach"
        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
        : "bg-muted text-muted-foreground border-border";

  return (
    <div className="mt-3 space-y-2 text-sm">
      <PayloadField label="Title" value={payload.title} />

      <div className="flex items-center gap-2">
        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${tierClass}`}>
          {lane ?? "Content"}
        </span>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Channel: <span className="text-foreground">{channel}</span></span>
        <span>•</span>
        <span>Publish: <span className="text-foreground">{publishAt}</span></span>
      </div>

      {primaryText && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap max-h-56 overflow-y-auto">
          {primaryText}
        </div>
      )}

      {!primaryText && (
        <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-48">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}

      {imageUrl && (
        <div className="mt-2 rounded-md border border-border/70 p-2 bg-background/40 space-y-2">
          <img
            src={imageUrl}
            alt={imageAlt}
            loading="lazy"
            className="w-full max-h-48 object-cover rounded-md border border-border/60"
          />
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{imageAlt}</p>
            {imageLicense && (
              <p className="text-[11px] text-muted-foreground">License/source: {imageLicense}</p>
            )}
          </div>
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowQualityScores((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {showQualityScores ? "▲ quality scores" : "▼ quality scores"}
        </button>
        {showQualityScores && (
          <div className="mt-2 grid grid-cols-1 gap-1 text-xs text-muted-foreground rounded-md border border-border/60 p-2 bg-background/40">
            <div>voice_gate: {String(metadata?.voice_gate ?? "—")}</div>
            <div>template_risk: {String(metadata?.template_risk ?? "—")}</div>
            <div>evidence_points: {String(metadata?.evidence_points ?? "—")}</div>
            <div>anti_pattern_violations: {String(metadata?.anti_pattern_violations ?? "—")}</div>
            <div>human_rewrite_pass_done: {String(metadata?.human_rewrite_pass_done ?? "—")}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function BudgetOverridePayload({ payload }: { payload: Record<string, unknown> }) {
  const budgetAmount = typeof payload.budgetAmount === "number" ? payload.budgetAmount : null;
  const observedAmount = typeof payload.observedAmount === "number" ? payload.observedAmount : null;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Scope" value={payload.scopeName ?? payload.scopeType} />
      <PayloadField label="Window" value={payload.windowKind} />
      <PayloadField label="Metric" value={payload.metric} />
      {(budgetAmount !== null || observedAmount !== null) ? (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Limit {budgetAmount !== null ? formatCents(budgetAmount) : "—"} · Observed {observedAmount !== null ? formatCents(observedAmount) : "—"}
        </div>
      ) : null}
      {!!payload.guidance && (
        <p className="text-muted-foreground">{String(payload.guidance)}</p>
      )}
    </div>
  );
}

export function ApprovalPayloadRenderer({ type, payload }: { type: string; payload: Record<string, unknown> }) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  return <CeoStrategyPayload payload={payload} />;
}
