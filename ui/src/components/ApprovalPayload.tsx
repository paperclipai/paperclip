import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck, Terminal } from "lucide-react";
import { formatCents } from "../lib/utils";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  budget_override_required: "Budget Override",
  tool_use: "Tool Use",
};

/**
 * Extract the human-facing tool name from a namespaced MCP tool name.
 * `mcp__paperclip__paperclip-plugin-linear__create-linear-issue` →
 * `create-linear-issue`. Non-MCP tools pass through unchanged.
 */
function shortToolName(fullName: string): string {
  if (!fullName.startsWith("mcp__")) return fullName;
  const parts = fullName.split("__").filter(Boolean);
  return parts[parts.length - 1] ?? fullName;
}

/** Truncate a string to a max length with an ellipsis suffix. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Build a contextual label for an approval. Examples:
 *   "Hire Agent: DevOps Engineer"
 *   "Tool Use · Bash: ls -la /tmp"
 *   "Tool Use · create-linear-issue: 'Fix login bug'"
 *   "CEO Strategy: Approve v2 migration plan"
 *   "Budget Override: monthly spend > $500"
 */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  const base = typeLabel[type] ?? type;

  if (type === "hire_agent" && payload?.name) {
    return `${base}: ${String(payload.name)}`;
  }

  if (type === "tool_use") {
    const toolRaw = typeof payload?.tool === "string" ? payload.tool : "unknown";
    const tool = shortToolName(toolRaw);
    // Pull a meaningful detail from the input for the most common tools.
    const input = (payload?.input ?? {}) as Record<string, unknown>;
    if (toolRaw === "Bash") {
      const cmd = typeof input.command === "string" ? input.command : "";
      if (cmd) return `${base} · ${tool}: ${truncate(cmd, 80)}`;
    }
    if (toolRaw === "Read" || toolRaw === "Write" || toolRaw === "Edit") {
      const p = typeof input.file_path === "string" ? input.file_path : "";
      if (p) return `${base} · ${tool}: ${truncate(p, 80)}`;
    }
    // MCP create/update tools often carry a `title` in the input.
    if (typeof input.title === "string" && input.title) {
      return `${base} · ${tool}: ${truncate(`'${input.title}'`, 80)}`;
    }
    if (typeof input.name === "string" && input.name) {
      return `${base} · ${tool}: ${truncate(input.name, 80)}`;
    }
    if (typeof input.query === "string" && input.query) {
      return `${base} · ${tool}: ${truncate(`"${input.query}"`, 80)}`;
    }
    // Fallback: payload summary (set by the chat worker when creating)
    const summary = typeof payload?.summary === "string" ? payload.summary : null;
    if (summary) return `${base} · ${truncate(summary, 100)}`;
    return `${base}: ${tool}`;
  }

  if (type === "approve_ceo_strategy") {
    const title = typeof payload?.title === "string" ? payload.title : null;
    if (title) return `${base}: ${truncate(title, 80)}`;
    const plan = typeof payload?.plan === "string" ? payload.plan : null;
    if (plan) return `${base}: ${truncate(plan.split("\n")[0] ?? plan, 80)}`;
  }

  if (type === "budget_override_required") {
    const scope = typeof payload?.scopeName === "string" ? payload.scopeName : null;
    if (scope) return `${base}: ${scope}`;
  }

  return base;
}

/**
 * Build a secondary descriptor for an approval, shown as a one-line
 * subtitle in list views. Returns null when there's nothing meaningful
 * to show beyond the status/requester metadata.
 */
export function approvalSubtitle(
  type: string,
  payload?: Record<string, unknown> | null,
): string | null {
  if (!payload) return null;
  if (type === "tool_use") {
    // Thread IDs by themselves aren't descriptive — the chat link is
    // rendered in the detail view instead.
    return null;
  }
  if (type === "approve_ceo_strategy") {
    const question = typeof payload.question === "string" ? payload.question : null;
    if (question) return truncate(question.split("\n")[0] ?? question, 120);
  }
  if (type === "hire_agent") {
    const role = typeof payload.role === "string" ? payload.role : null;
    const title = typeof payload.title === "string" ? payload.title : null;
    if (role && title) return `${title} · ${role}`;
    if (role) return role;
  }
  return null;
}

/**
 * If the payload carries an origin reference (e.g. a chat thread ID),
 * return a { href, label } tuple pointing back to where the approval
 * was created. Returns null if we don't know the origin.
 */
export function approvalOriginLink(
  type: string,
  payload?: Record<string, unknown> | null,
): { href: string; label: string } | null {
  if (!payload) return null;
  if (type === "tool_use") {
    const threadId = typeof payload.threadId === "string" ? payload.threadId : null;
    if (threadId) {
      return {
        href: `/plugins/paperclip-chat?threadId=${encodeURIComponent(threadId)}`,
        label: "Open chat thread",
      };
    }
  }
  return null;
}

/** Format an ISO timestamp as a locale-aware absolute string for tooltips. */
export function absoluteTime(iso: string | Date): string {
  try {
    const d = typeof iso === "string" ? new Date(iso) : iso;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  budget_override_required: ShieldAlert,
  tool_use: Terminal,
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

/**
 * Renders a `tool_use` approval payload. Shows the tool name prominently,
 * the input as pretty-printed JSON, and — when present — the triggering
 * chat thread ID + human summary line.
 */
export function ToolUsePayload({ payload }: { payload: Record<string, unknown> }) {
  const tool = typeof payload.tool === "string" ? payload.tool : "(unknown tool)";
  const shortName = shortToolName(tool);
  const isBuiltin = !tool.startsWith("mcp__");
  const input = payload.input;
  const summary = typeof payload.summary === "string" ? payload.summary : null;
  const origin = approvalOriginLink("tool_use", payload);

  // Special-case Bash: show the command prominently as code.
  const isBash = tool === "Bash";
  const bashCommand =
    isBash && input && typeof (input as { command?: unknown }).command === "string"
      ? ((input as { command: string }).command)
      : null;

  return (
    <div className="mt-3 space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Tool</span>
        <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
          {shortName}
        </span>
        {!isBuiltin && (
          <span className="text-[10px] text-muted-foreground">
            (plugin)
          </span>
        )}
      </div>

      {bashCommand && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Command</span>
          <pre className="flex-1 rounded-md bg-muted/50 px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-all overflow-x-auto">
            {bashCommand}
          </pre>
        </div>
      )}

      {!bashCommand && input !== undefined && input !== null && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Input</span>
          <pre className="flex-1 rounded-md bg-muted/50 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-all overflow-x-auto max-h-64">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}

      {summary && !bashCommand && (
        <PayloadField label="Summary" value={summary} />
      )}
      {origin && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Origin</span>
          <a
            href={origin.href}
            className="text-xs text-primary hover:underline underline-offset-2"
          >
            {origin.label}
          </a>
        </div>
      )}
    </div>
  );
}

export function ApprovalPayloadRenderer({ type, payload }: { type: string; payload: Record<string, unknown> }) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "tool_use") return <ToolUsePayload payload={payload} />;
  return <CeoStrategyPayload payload={payload} />;
}
