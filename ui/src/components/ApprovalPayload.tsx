import { useState } from "react";
import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck, Plug, BookOpen, Puzzle, KeyRound, Copy, Check } from "lucide-react";
import { formatCents } from "../lib/utils";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  budget_override_required: "Budget Override",
  request_board_approval: "Board Approval",
  request_mcp_install: "MCP Server",
  request_skill_install: "Skill Install",
  request_plugin_install: "Plugin Install",
  request_credential: "Credential Request",
};

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function approvalSubject(payload?: Record<string, unknown> | null): string | null {
  return firstNonEmptyString(
    payload?.title,
    payload?.name,
    payload?.packageName,
    payload?.catalogSkillId,
    payload?.service,
    payload?.summary,
    payload?.recommendedAction,
  );
}

/** Build a contextual label for an approval, e.g. "Hire Agent: Designer" */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  const base = typeLabel[type] ?? type;
  const subject = approvalSubject(payload);
  if (subject) {
    return `${base}: ${subject}`;
  }
  return base;
}

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  budget_override_required: ShieldAlert,
  request_board_approval: ShieldCheck,
  request_mcp_install: Plug,
  request_skill_install: BookOpen,
  request_plugin_install: Puzzle,
  request_credential: KeyRound,
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

export function BoardApprovalPayload({
  payload,
  hideTitle = false,
}: {
  payload: Record<string, unknown>;
  hideTitle?: boolean;
}) {
  const nextPayload = hideTitle ? { ...payload, title: undefined } : payload;
  return (
    <BoardApprovalPayloadContent payload={nextPayload} />
  );
}

function BoardApprovalPayloadContent({ payload }: { payload: Record<string, unknown> }) {
  const risks = Array.isArray(payload.risks)
    ? payload.risks
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const title = firstNonEmptyString(payload.title);
  const summary = firstNonEmptyString(payload.summary);
  const recommendedAction = firstNonEmptyString(payload.recommendedAction);
  const nextActionOnApproval = firstNonEmptyString(payload.nextActionOnApproval);
  const proposedComment = firstNonEmptyString(payload.proposedComment);

  return (
    <div className="mt-4 space-y-3.5 text-sm">
      {title && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Title</p>
          <p className="font-medium leading-6 text-foreground">{title}</p>
        </div>
      )}
      {summary && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Summary</p>
          <p className="leading-6 text-foreground/90">{summary}</p>
        </div>
      )}
      {recommendedAction && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">
            Recommended action
          </p>
          <p className="mt-1 leading-6 text-foreground">{recommendedAction}</p>
        </div>
      )}
      {nextActionOnApproval && (
        <div className="rounded-lg border border-border/60 bg-background/60 px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">On approval</p>
          <p className="mt-1 leading-6 text-foreground">{nextActionOnApproval}</p>
        </div>
      )}
      {risks.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Risks</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {risks.map((risk) => (
              <li key={risk} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                <span className="leading-6">{risk}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposedComment && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Proposed comment
          </p>
          <pre className="max-h-48 overflow-auto rounded-lg border border-border/60 bg-muted/50 px-3.5 py-3 font-mono text-xs leading-5 text-muted-foreground whitespace-pre-wrap">
            {proposedComment}
          </pre>
        </div>
      )}
    </div>
  );
}

function McpInstallPayload({ payload }: { payload: Record<string, unknown> }) {
  const transport = String(payload.transport ?? "");
  const env = Array.isArray(payload.env) ? payload.env : [];
  const secretEntries = env.filter(
    (e): e is Record<string, unknown> => typeof e === "object" && e !== null && typeof (e as Record<string, unknown>).secretName === "string",
  );
  const command = firstNonEmptyString(payload.command);
  const args = Array.isArray(payload.args) ? payload.args.map((a) => String(a)) : [];
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Server" value={payload.name} />
      <PayloadField label="Transport" value={transport} />
      {transport === "http" && <PayloadField label="URL" value={payload.url} />}
      {transport === "stdio" && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Command</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] break-all">
            {[command, ...args].filter(Boolean).join(" ") || "—"}
          </code>
        </div>
      )}
      {!!payload.reason && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Reason</span>
          <span className="text-muted-foreground">{String(payload.reason)}</span>
        </div>
      )}
      {secretEntries.length > 0 && (
        <div className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs">
          <p className="font-medium text-amber-700 dark:text-amber-300">Secrets required before approval</p>
          <p className="mt-1 text-muted-foreground">
            Create these as company secrets (by exact name) so the server can authenticate. Values never appear here.
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {secretEntries.map((e) => (
              <span key={String(e.secretName)} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {String(e.secretName)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SkillInstallPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Skill" value={payload.catalogSkillId} />
      <PayloadField label="Slug" value={payload.slug} />
      {!!payload.reason && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Reason</span>
          <span className="text-muted-foreground">{String(payload.reason)}</span>
        </div>
      )}
    </div>
  );
}

function PluginInstallPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Package</span>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] break-all">
          {String(payload.packageName ?? "—")}{payload.version ? `@${String(payload.version)}` : ""}
        </code>
      </div>
      {!!payload.reason && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Reason</span>
          <span className="text-muted-foreground">{String(payload.reason)}</span>
        </div>
      )}
      <div className="mt-2 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-muted-foreground">
        Plugins run privileged server code instance-wide. Approving requires an instance admin.
      </div>
    </div>
  );
}

function LinkifiedText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-600 underline underline-offset-2 break-all dark:text-blue-400"
          >
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function CredentialRequestPayload({ payload }: { payload: Record<string, unknown> }) {
  const howToObtain = typeof payload.howToObtain === "string" ? payload.howToObtain.trim() : "";
  const browserAgentPrompt =
    typeof payload.browserAgentPrompt === "string" ? payload.browserAgentPrompt.trim() : "";
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Service" value={payload.service} />
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Env var</span>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{String(payload.envKey ?? "—")}</code>
      </div>
      <PayloadField label="Scope" value={payload.scope} />
      {!!payload.reason && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Reason</span>
          <span className="text-muted-foreground">{String(payload.reason)}</span>
        </div>
      )}
      {howToObtain && (
        <div className="mt-2 rounded-lg border border-border/60 bg-background/60 px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">How to obtain it</p>
          <p className="mt-1 whitespace-pre-wrap leading-6 text-foreground/90">
            <LinkifiedText text={howToObtain} />
          </p>
        </div>
      )}
      {browserAgentPrompt && (
        <div className="mt-2 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3.5 py-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-blue-700 dark:text-blue-300">
              For your browser agent (e.g. Claude for Chrome)
            </p>
            <CopyButton text={browserAgentPrompt} label="Copy prompt" />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Paste this into a browser-driving agent to fetch the value, then paste the result below.
          </p>
          <pre className="mt-1.5 max-h-48 overflow-auto rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground whitespace-pre-wrap">
            {browserAgentPrompt}
          </pre>
        </div>
      )}
      <div className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-muted-foreground">
        Provide the secret value below. It is stored encrypted and injected into the agent's run environment as
        {" "}<code className="font-mono">${String(payload.envKey ?? "ENV")}</code>. The value never appears in the request, logs, or activity.
      </div>
    </div>
  );
}

export function ApprovalPayloadRenderer({
  type,
  payload,
  hidePrimaryTitle = false,
}: {
  type: string;
  payload: Record<string, unknown>;
  hidePrimaryTitle?: boolean;
}) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "request_mcp_install") return <McpInstallPayload payload={payload} />;
  if (type === "request_skill_install") return <SkillInstallPayload payload={payload} />;
  if (type === "request_plugin_install") return <PluginInstallPayload payload={payload} />;
  if (type === "request_credential") return <CredentialRequestPayload payload={payload} />;
  if (type === "request_board_approval") {
    return <BoardApprovalPayload payload={payload} hideTitle={hidePrimaryTitle} />;
  }
  return <CeoStrategyPayload payload={payload} />;
}
