import { UserPlus, Lightbulb, ShieldCheck, BookOpenCheck } from "lucide-react";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  learned_skill: "Learned Skill",
};

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  learned_skill: BookOpenCheck,
};

export const defaultTypeIcon = ShieldCheck;

function PayloadField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">{String(value)}</span>
    </div>
  );
}

function PayloadMonoField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-mono text-muted-foreground">{String(value)}</span>
    </div>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="text-xs text-muted-foreground">Name</span>
        <span className="font-medium">{String(payload.name ?? "—")}</span>
      </div>
      <PayloadField label="Role" value={payload.role} />
      <PayloadField label="Title" value={payload.title} />
      <PayloadField label="Icon" value={payload.icon} />
      {!!payload.capabilities && (
        <div className="flex items-start justify-between gap-3 py-1">
          <span className="text-xs text-muted-foreground">Capabilities</span>
          <span className="text-muted-foreground">{String(payload.capabilities)}</span>
        </div>
      )}
      {!!payload.adapterType && (
        <div className="flex items-center justify-between gap-3 py-1">
          <span className="text-xs text-muted-foreground">Adapter</span>
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

export function ApprovalPayloadRenderer({ type, payload }: { type: string; payload: Record<string, unknown> }) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "learned_skill") return <LearnedSkillPayload payload={payload} />;
  return <CeoStrategyPayload payload={payload} />;
}

export function LearnedSkillPayload({ payload }: { payload: Record<string, unknown> }) {
  const provenance =
    payload.provenance && typeof payload.provenance === "object"
      ? (payload.provenance as Record<string, unknown>)
      : null;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="text-xs text-muted-foreground">Skill</span>
        <span className="font-medium">{String(payload.skillName ?? "—")}</span>
      </div>
      <PayloadField label="Tier" value={payload.tier} />
      <PayloadMonoField label="Agent" value={payload.agentId} />
      <PayloadField label="Confidence" value={payload.confidence} />
      <PayloadMonoField label="Run" value={payload.sourceRunId} />
      <PayloadMonoField label="Chat session" value={payload.sourceChatSessionId} />
      <PayloadMonoField label="Chat message" value={payload.sourceChatMessageId} />
      <PayloadField label="Authoring skill" value={provenance?.authoringSkill} />
      {!!payload.summary && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap">
          {String(payload.summary)}
        </div>
      )}
      {!!payload.draftSkillContent && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
          {String(payload.draftSkillContent)}
        </div>
      )}
    </div>
  );
}
