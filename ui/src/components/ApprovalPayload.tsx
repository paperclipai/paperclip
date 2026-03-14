import { UserPlus, Lightbulb, ShieldCheck, Target, CheckCircle } from "lucide-react";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  goal_plan: "Goal Plan",
  goal_completion: "Goal Completion",
};

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  goal_plan: Target,
  goal_completion: CheckCircle,
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

export function GoalPlanPayload({ payload }: { payload: Record<string, unknown> }) {
  const subgoals = Array.isArray(payload.subgoals) ? payload.subgoals : [];
  const projects = Array.isArray(payload.projects) ? payload.projects : [];
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  const plan = payload.plan ?? payload.description ?? payload.summary;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Goal" value={payload.goalTitle} />
      {!!plan && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap font-mono text-xs max-h-48 overflow-y-auto">
          {String(plan)}
        </div>
      )}
      {subgoals.length > 0 && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Subgoals</span>
          <span>{subgoals.length} proposed</span>
        </div>
      )}
      {projects.length > 0 && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Projects</span>
          <span>{projects.length} proposed</span>
        </div>
      )}
      {issues.length > 0 && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Issues</span>
          <span>{issues.length} estimated</span>
        </div>
      )}
      {!!payload.agentAssignments && (
        typeof payload.agentAssignments === "object" ? (
          <div className="flex items-start gap-2">
            <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Agents</span>
            <pre className="rounded-md bg-muted/40 px-2 py-1 text-xs text-muted-foreground overflow-x-auto max-h-32">
              {JSON.stringify(payload.agentAssignments, null, 2)}
            </pre>
          </div>
        ) : (
          <PayloadField label="Agents" value={payload.agentAssignments} />
        )
      )}
      <PayloadField label="Budget" value={payload.budgetEstimate} />
      {!plan && subgoals.length === 0 && projects.length === 0 && issues.length === 0 && (
        <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-48">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function GoalCompletionPayload({ payload }: { payload: Record<string, unknown> }) {
  const report = payload.report ?? payload.summary ?? payload.completionReport;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Goal" value={payload.goalTitle} />
      <PayloadField label="Status" value={payload.outcome ?? "Complete"} />
      {!!report && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap font-mono text-xs max-h-48 overflow-y-auto">
          {String(report)}
        </div>
      )}
      <PayloadField label="Issues Done" value={payload.issuesDone} />
      <PayloadField label="Issues Total" value={payload.issuesTotal} />
      {!report && (
        <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-48">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function ApprovalPayloadRenderer({ type, payload }: { type: string; payload: Record<string, unknown> }) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "goal_plan") return <GoalPlanPayload payload={payload} />;
  if (type === "goal_completion") return <GoalCompletionPayload payload={payload} />;
  return <CeoStrategyPayload payload={payload} />;
}
