import { UserPlus, Lightbulb, ShieldCheck, ClipboardCheck } from "lucide-react";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  eval_review: "Eval Review",
};

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  eval_review: ClipboardCheck,
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
    </div>
  );
}

export function CeoStrategyPayload({ payload }: { payload: Record<string, unknown> }) {
  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Title" value={payload.title} />
      {!!plan && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap font-mono text-xs max-h-48 overflow-y-auto">
          {String(plan)}
        </div>
      )}
      {!plan && (
        <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-48">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

function EvalReviewPayload({ payload }: { payload: Record<string, unknown> }) {
  const results = (payload.results ?? []) as Array<{
    kind: string;
    score: number;
    label: string;
    rationale?: string;
  }>;
  const judge = payload.judge as { provider?: string; model?: string; latencyMs?: number } | undefined;

  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Description" value={payload.description} />
      {judge && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Judge</span>
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {judge.provider}/{judge.model}
          </span>
        </div>
      )}
      {results.length > 0 && (
        <div className="mt-2 space-y-1">
          {results.map((r) => (
            <div key={r.kind} className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground w-20 sm:w-24 shrink-0">{r.kind}</span>
              <span
                className={`font-mono px-1.5 py-0.5 rounded ${
                  r.label === "fail"
                    ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                    : r.label === "warn"
                      ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                      : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                }`}
              >
                {r.label} ({typeof r.score === "number" ? r.score.toFixed(2) : "—"})
              </span>
              {r.rationale && (
                <span className="text-muted-foreground truncate">{r.rationale}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ApprovalPayloadRenderer({ type, payload }: { type: string; payload: Record<string, unknown> }) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "eval_review") return <EvalReviewPayload payload={payload} />;
  return <CeoStrategyPayload payload={payload} />;
}
