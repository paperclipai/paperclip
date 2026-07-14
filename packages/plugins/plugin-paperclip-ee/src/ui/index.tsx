import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useHostContext, usePluginData, usePluginToast, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";

type Effect = "allow" | "deny";
type SkillPolicyAction =
  | "skills.create"
  | "skills.import"
  | "skills.install"
  | "skills.edit"
  | "skills.update"
  | "skills.test"
  | "skills.reset"
  | "skills.remove";
type SkillPolicySourceType = "workspace" | "catalog" | "git" | "external_package" | "generated" | "unknown";
type SkillPolicySubject =
  | { type: "all_agents" }
  | { type: "roles"; roles: string[] }
  | { type: "agents"; agentIds: string[] };
type SkillPolicyRule = {
  id: string;
  priority: number;
  effect: Effect;
  subject: SkillPolicySubject;
  actions: SkillPolicyAction[];
  resources?: {
    skillIds?: string[];
    skillKeys?: string[];
    sourceTypes?: SkillPolicySourceType[];
    sourceLocators?: string[];
  };
};
type EffectiveSkillPolicy = {
  schemaVersion: 1;
  revision: number;
  defaultEffect: Effect;
  rules: SkillPolicyRule[];
  materialized: boolean;
};
type PolicyDecision = {
  allowed: boolean;
  action: SkillPolicyAction;
  reason: "platform_invariant" | "no_policy_default" | "explicit_rule" | "policy_default" | "legacy_compatibility";
  policyRevision: number;
  matchedRuleId: string | null;
  remediation: string | null;
};
type AgentSummary = { id: string; name: string; role: string; status?: string | null };
type ActivityEntry = {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown> | null;
  createdAt: string;
};
type Availability = { status: "ready" | "failed"; pluginId: string; companyId: string | null; checkedAt: string };

const ACTIONS: Array<{ id: SkillPolicyAction; label: string }> = [
  { id: "skills.create", label: "Create" },
  { id: "skills.import", label: "Import" },
  { id: "skills.install", label: "Install" },
  { id: "skills.edit", label: "Edit" },
  { id: "skills.update", label: "Update" },
  { id: "skills.test", label: "Test" },
  { id: "skills.reset", label: "Reset" },
  { id: "skills.remove", label: "Remove" },
];
const SOURCE_TYPES: SkillPolicySourceType[] = ["workspace", "catalog", "git", "external_package", "generated", "unknown"];
const ADMIN_ROLES = ["board", "admin", "administrator", "ceo", "cto"];

const pageStyle: CSSProperties = { display: "grid", gap: "var(--space-5, 1.25rem)", padding: "var(--space-5, 1.25rem)", color: "var(--foreground)" };
const heroStyle: CSSProperties = { border: "1px solid var(--border)", borderRadius: "var(--radius-2xl)", padding: "var(--space-5, 1.25rem)", background: "linear-gradient(135deg, color-mix(in oklab, var(--accent) 76%, transparent), color-mix(in oklab, var(--card) 88%, transparent))" };
const gridStyle: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 18rem), 1fr))", gap: "var(--space-3, 0.75rem)" };
const cardStyle: CSSProperties = { border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", padding: "var(--space-4, 1rem)", background: "var(--card)", display: "grid", gap: "var(--space-3, 0.75rem)" };
const sectionStyle: CSSProperties = { ...cardStyle, overflow: "hidden" };
const rowStyle: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2, 0.5rem)" };
const mutedStyle: CSSProperties = { color: "var(--muted-foreground)", fontSize: "var(--text-xs, 0.75rem)", lineHeight: 1.5 };
const inputStyle: CSSProperties = { width: "100%", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: "var(--space-2, 0.5rem) var(--space-3, 0.75rem)", background: "var(--background)", color: "var(--foreground)" };
const tableStyle: CSSProperties = { width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: "var(--text-xs, 0.75rem)" };
const thStyle: CSSProperties = { textAlign: "left", padding: "var(--space-2, 0.5rem)", background: "color-mix(in oklab, var(--accent) 55%, transparent)", color: "var(--muted-foreground)", borderBottom: "1px solid var(--border)" };
const tdStyle: CSSProperties = { padding: "var(--space-2, 0.5rem)", borderBottom: "1px solid var(--border)", verticalAlign: "top" };
const rawJsonStyle: CSSProperties = { margin: 0, padding: "var(--space-3, 0.75rem)", borderRadius: "var(--radius-lg)", background: "var(--muted)", color: "var(--foreground)", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs, 0.75rem)", lineHeight: 1.5 };

function buttonStyle(variant: "primary" | "secondary" | "danger" = "secondary"): CSSProperties {
  const primary = variant === "primary";
  const danger = variant === "danger";
  return {
    border: `1px solid ${primary ? "var(--primary)" : danger ? "var(--destructive)" : "var(--border)"}`,
    borderRadius: "var(--radius-full, 999rem)",
    padding: "var(--space-2, 0.5rem) var(--space-3, 0.75rem)",
    background: primary ? "var(--primary)" : "transparent",
    color: primary ? "var(--primary-foreground)" : danger ? "var(--destructive)" : "var(--foreground)",
    cursor: "pointer",
    font: "inherit",
  };
}

function badgeStyle(tone: "neutral" | "allow" | "deny" | "warn"): CSSProperties {
  const color = tone === "allow" ? "var(--status-task-done)" : tone === "deny" ? "var(--destructive)" : tone === "warn" ? "var(--status-task-todo)" : "var(--muted-foreground)";
  return {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: "var(--radius-full, 999rem)",
    border: `1px solid color-mix(in oklab, ${color} 42%, var(--border))`,
    background: `color-mix(in oklab, ${color} 13%, transparent)`,
    color,
    padding: "var(--space-1, 0.25rem) var(--space-2, 0.5rem)",
    fontSize: "var(--text-xs, 0.75rem)",
    width: "fit-content",
  };
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.error ?? data?.message ?? `Request failed with ${res.status}`;
    throw Object.assign(new Error(message), { status: res.status, details: data });
  }
  return data as T;
}

function useCompanyPolicy(companyId: string | null) {
  const [policy, setPolicy] = useState<EffectiveSkillPolicy | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [audit, setAudit] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const [nextPolicy, nextAgents, nextAudit] = await Promise.all([
        apiJson<EffectiveSkillPolicy>(`/api/companies/${encodeURIComponent(companyId)}/skill-policy`),
        apiJson<AgentSummary[]>(`/api/companies/${encodeURIComponent(companyId)}/agents`),
        apiJson<ActivityEntry[]>(`/api/companies/${encodeURIComponent(companyId)}/activity?entityType=company_skill_policy&entityId=${encodeURIComponent(companyId)}&limit=25`),
      ]);
      setPolicy(nextPolicy);
      setAgents(nextAgents);
      setAudit(nextAudit.filter((entry) => entry.action.startsWith("company.skill_policy_")));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { policy, agents, audit, loading, error, refresh, setPolicy };
}

export function buildOpenPreset(): Pick<EffectiveSkillPolicy, "schemaVersion" | "defaultEffect" | "rules"> {
  return { schemaVersion: 1, defaultEffect: "allow", rules: [] };
}

export function buildRestrictedAuthorsPreset(): Pick<EffectiveSkillPolicy, "schemaVersion" | "defaultEffect" | "rules"> {
  return {
    schemaVersion: 1,
    defaultEffect: "allow",
    rules: [
      {
        id: "deny-external-installs",
        priority: 100,
        effect: "deny",
        subject: { type: "all_agents" },
        actions: ["skills.install", "skills.import"],
        resources: { sourceTypes: ["git", "external_package"] },
      },
      {
        id: "allow-admin-external-installs",
        priority: 50,
        effect: "allow",
        subject: { type: "roles", roles: ADMIN_ROLES },
        actions: ["skills.install", "skills.import"],
        resources: { sourceTypes: ["git", "external_package"] },
      },
    ],
  };
}

export function buildAdminsOnlyPreset(): Pick<EffectiveSkillPolicy, "schemaVersion" | "defaultEffect" | "rules"> {
  return {
    schemaVersion: 1,
    defaultEffect: "deny",
    rules: [
      {
        id: "allow-admins-all-skill-actions",
        priority: 10,
        effect: "allow",
        subject: { type: "roles", roles: ADMIN_ROLES },
        actions: ACTIONS.map((action) => action.id),
      },
    ],
  };
}

function subjectLabel(subject: SkillPolicySubject) {
  if (subject.type === "all_agents") return "All agents";
  if (subject.type === "roles") return `Roles: ${subject.roles.join(", ")}`;
  return `Agents: ${subject.agentIds.length}`;
}

function resourceLabel(rule: SkillPolicyRule) {
  const resource = rule.resources;
  if (!resource) return "All skills and sources";
  return [
    resource.skillKeys?.length ? `Skill keys: ${resource.skillKeys.join(", ")}` : null,
    resource.sourceTypes?.length ? `Sources: ${resource.sourceTypes.join(", ")}` : null,
    resource.sourceLocators?.length ? `Locators: ${resource.sourceLocators.join(", ")}` : null,
  ].filter(Boolean).join(" · ") || "All resources";
}

function relativeTime(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(diff / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function PresetCard({ title, body, warning, onPreview }: { title: string; body: string; warning?: string; onPreview: () => void }) {
  return <button type="button" style={{ ...cardStyle, textAlign: "left", cursor: "pointer" }} onClick={onPreview}>
    <strong>{title}</strong>
    <span style={mutedStyle}>{body}</span>
    {warning ? <span style={badgeStyle("warn")}>{warning}</span> : null}
  </button>;
}

function RuleEditor({ draft, setDraft, agents }: { draft: EffectiveSkillPolicy; setDraft: (policy: EffectiveSkillPolicy) => void; agents: AgentSummary[] }) {
  const [subjectType, setSubjectType] = useState<"all_agents" | "roles" | "agents">("all_agents");
  const [roles, setRoles] = useState("Engineer");
  const [agentIds, setAgentIds] = useState("");
  const [effect, setEffect] = useState<Effect>("deny");
  const [actions, setActions] = useState<SkillPolicyAction[]>(["skills.install"]);
  const [sourceTypes, setSourceTypes] = useState<SkillPolicySourceType[]>([]);
  const [skillKeys, setSkillKeys] = useState("");
  const [priority, setPriority] = useState(String((draft.rules.at(-1)?.priority ?? 0) + 10));

  function addRule(event: FormEvent) {
    event.preventDefault();
    const subject: SkillPolicySubject = subjectType === "all_agents"
      ? { type: "all_agents" }
      : subjectType === "roles"
        ? { type: "roles", roles: roles.split(",").map((item) => item.trim()).filter(Boolean) }
        : { type: "agents", agentIds: agentIds.split(",").map((item) => item.trim()).filter(Boolean) };
    const resources: SkillPolicyRule["resources"] = {};
    const parsedSkillKeys = skillKeys.split(",").map((item) => item.trim()).filter(Boolean);
    if (parsedSkillKeys.length) resources.skillKeys = parsedSkillKeys;
    if (sourceTypes.length) resources.sourceTypes = sourceTypes;
    const rule: SkillPolicyRule = {
      id: `${effect}-${Date.now().toString(36)}`,
      priority: Number(priority) || 100,
      effect,
      subject,
      actions,
      ...(Object.keys(resources).length ? { resources } : {}),
    };
    setDraft({ ...draft, materialized: true, rules: [...draft.rules, rule] });
  }

  return <form style={sectionStyle} onSubmit={addRule} aria-label="Rule editor">
    <div style={rowStyle}>
      <strong>Add override</strong>
      <span style={mutedStyle}>Rules evaluate by priority, then rule id.</span>
    </div>
    <div style={gridStyle}>
      <label>Subject
        <select style={inputStyle} value={subjectType} onChange={(event) => setSubjectType(event.target.value as typeof subjectType)}>
          <option value="all_agents">All agents</option>
          <option value="roles">Roles</option>
          <option value="agents">Agents</option>
        </select>
      </label>
      {subjectType === "roles" ? <label>Roles
        <input style={inputStyle} value={roles} onChange={(event) => setRoles(event.target.value)} placeholder="Engineer, QA" />
      </label> : null}
      {subjectType === "agents" ? <label>Agent IDs
        <input style={inputStyle} value={agentIds} onChange={(event) => setAgentIds(event.target.value)} placeholder={agents[0]?.id ?? "agent uuid"} />
      </label> : null}
      <label>Effect
        <select style={inputStyle} value={effect} onChange={(event) => setEffect(event.target.value as Effect)}>
          <option value="deny">Deny</option>
          <option value="allow">Allow</option>
        </select>
      </label>
      <label>Priority
        <input style={inputStyle} value={priority} onChange={(event) => setPriority(event.target.value)} />
      </label>
      <label>Protected skill keys
        <input style={inputStyle} value={skillKeys} onChange={(event) => setSkillKeys(event.target.value)} placeholder="paperclipai/bundled/..." />
      </label>
    </div>
    <fieldset style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "var(--space-3, 0.75rem)" }}>
      <legend>Actions</legend>
      <div style={rowStyle}>{ACTIONS.map((action) => <label key={action.id} style={rowStyle}>
        <input type="checkbox" checked={actions.includes(action.id)} onChange={(event) => setActions(event.target.checked ? [...actions, action.id] : actions.filter((id) => id !== action.id))} /> {action.label}
      </label>)}</div>
    </fieldset>
    <fieldset style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "var(--space-3, 0.75rem)" }}>
      <legend>Source overrides</legend>
      <div style={rowStyle}>{SOURCE_TYPES.map((source) => <label key={source} style={rowStyle}>
        <input type="checkbox" checked={sourceTypes.includes(source)} onChange={(event) => setSourceTypes(event.target.checked ? [...sourceTypes, source] : sourceTypes.filter((id) => id !== source))} /> {source}
      </label>)}</div>
    </fieldset>
    <button type="submit" style={buttonStyle("primary")}>Add rule</button>
  </form>;
}

function RuleTable({ draft, setDraft, highlightedRuleId }: { draft: EffectiveSkillPolicy; setDraft: (policy: EffectiveSkillPolicy) => void; highlightedRuleId: string | null }) {
  function removeRule(id: string) {
    setDraft({ ...draft, rules: draft.rules.filter((rule) => rule.id !== id) });
  }
  function moveRule(id: string, delta: number) {
    setDraft({ ...draft, rules: draft.rules.map((rule) => rule.id === id ? { ...rule, priority: rule.priority + delta } : rule) });
  }
  const sorted = [...draft.rules].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  if (!sorted.length) return <div style={sectionStyle}><strong>No overrides yet</strong><p style={mutedStyle}>Open default has no materialized rules. Add a restriction or apply a preset to start.</p></div>;
  return <div style={sectionStyle}>
    <div style={{ overflowX: "auto" }}>
      <table style={tableStyle}>
        <thead><tr><th style={thStyle}>Priority</th><th style={thStyle}>Effect</th><th style={thStyle}>Subject</th><th style={thStyle}>Actions</th><th style={thStyle}>Resource</th><th style={thStyle}>Order</th></tr></thead>
        <tbody>{sorted.map((rule) => {
          const isHighlighted = highlightedRuleId === rule.id;
          return <tr key={rule.id} id={`rule-${rule.id}`} tabIndex={isHighlighted ? 0 : undefined} aria-label={isHighlighted ? `Matched rule ${rule.id}` : undefined} style={{ background: isHighlighted ? "color-mix(in oklab, var(--primary) 10%, transparent)" : undefined, scrollMarginBlock: "var(--space-6, 1.5rem)" }}>
          <td style={tdStyle}>{rule.priority}<br /><span style={mutedStyle}>{rule.id}</span></td>
          <td style={tdStyle}><span style={badgeStyle(rule.effect === "allow" ? "allow" : "deny")}>{rule.effect}</span></td>
          <td style={tdStyle}>{subjectLabel(rule.subject)}</td>
          <td style={tdStyle}>{rule.actions.map((action) => ACTIONS.find((item) => item.id === action)?.label ?? action).join(", ")}</td>
          <td style={tdStyle}>{resourceLabel(rule)}</td>
          <td style={tdStyle}><div style={rowStyle}>
            <button type="button" style={buttonStyle()} onClick={() => moveRule(rule.id, -10)}>Move up</button>
            <button type="button" style={buttonStyle()} onClick={() => moveRule(rule.id, 10)}>Move down</button>
            <button type="button" style={buttonStyle("danger")} onClick={() => removeRule(rule.id)}>Remove</button>
          </div></td>
        </tr>;
        })}</tbody>
      </table>
    </div>
  </div>;
}

function SimulationPanel({ companyId, rules, onOpenRule }: { companyId: string; rules: SkillPolicyRule[]; onOpenRule: (ruleId: string) => void }) {
  const [action, setAction] = useState<SkillPolicyAction>("skills.install");
  const [sourceType, setSourceType] = useState<SkillPolicySourceType>("external_package");
  const [skillKey, setSkillKey] = useState("");
  const [decision, setDecision] = useState<PolicyDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function explain(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setDecision(null);
    try {
      setDecision(await apiJson<PolicyDecision>(`/api/companies/${encodeURIComponent(companyId)}/skill-policy/evaluate`, {
        method: "POST",
        body: JSON.stringify({ action, resource: { sourceType, ...(skillKey.trim() ? { skillKey: skillKey.trim() } : {}) } }),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const matched = decision?.matchedRuleId ? rules.find((rule) => rule.id === decision.matchedRuleId) : null;
  return <section style={sectionStyle} aria-label="Effective policy simulation">
    <strong>Effective policy & simulation</strong>
    <form style={gridStyle} onSubmit={explain}>
      <label>Action
        <select style={inputStyle} value={action} onChange={(event) => setAction(event.target.value as SkillPolicyAction)}>{ACTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      </label>
      <label>Source type
        <select style={inputStyle} value={sourceType} onChange={(event) => setSourceType(event.target.value as SkillPolicySourceType)}>{SOURCE_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}</select>
      </label>
      <label>Skill key
        <input style={inputStyle} value={skillKey} onChange={(event) => setSkillKey(event.target.value)} placeholder="optional protected skill key" />
      </label>
      <button type="submit" style={buttonStyle("primary")}>Explain</button>
    </form>
    {error ? <div role="alert" style={{ ...cardStyle, borderColor: "var(--destructive)" }}>{error}</div> : null}
    {decision ? <div style={cardStyle}>
      <span style={badgeStyle(decision.allowed ? "allow" : "deny")}>{decision.allowed ? "Allowed" : "Denied"}</span>
      <div><strong>Reason:</strong> {decision.reason === "platform_invariant" ? "Platform safety - cannot be changed" : decision.reason === "explicit_rule" ? "Matched explicit rule" : decision.reason === "legacy_compatibility" ? "Legacy grant applied as compatibility allow" : decision.reason === "no_policy_default" ? "Open default" : "Company policy default"}</div>
      <div><strong>Policy revision:</strong> {decision.policyRevision}</div>
      {matched ? <div style={{ ...cardStyle, background: "color-mix(in oklab, var(--primary) 8%, var(--card))" }}>
        <div style={rowStyle}><strong>Matched override</strong><span style={badgeStyle(matched.effect === "allow" ? "allow" : "deny")}>{matched.effect}</span></div>
        <p style={mutedStyle}>{matched.id} · {subjectLabel(matched.subject)} · {resourceLabel(matched)}</p>
        <a href={`#rule-${matched.id}`} style={buttonStyle()} onClick={(event) => { event.preventDefault(); onOpenRule(matched.id); }}>View matched override in editor</a>
      </div> : null}
      {decision.remediation ? <div><strong>Remediation:</strong> {decision.remediation}</div> : null}
      <p style={mutedStyle}>Legacy `skills:create` and `skills:suggest-changes` grants can only allow compatibility when no explicit rule matched; they never override a deny or platform invariant.</p>
    </div> : null}
  </section>;
}

function AuditHistory({ entries }: { entries: ActivityEntry[] }) {
  return <section style={sectionStyle} aria-label="Policy audit history">
    <strong>Audit history</strong>
    {entries.length === 0 ? <p style={mutedStyle}>No policy mutations have been recorded yet.</p> : entries.map((entry) => <article key={entry.id} style={cardStyle}>
      <div style={rowStyle}><span style={badgeStyle("neutral")}>{String(entry.details?.previousRevision ?? "?")} {"->"} {String(entry.details?.newRevision ?? "?")}</span><strong>{entry.action.replace("company.skill_policy_", "")}</strong><span style={mutedStyle}>{relativeTime(entry.createdAt)}</span></div>
      <p style={mutedStyle}>Actor {entry.actorType}:{entry.actorId} changed {entry.entityType}. Summary: {entry.details ? JSON.stringify(entry.details) : "No details"}</p>
      <details>
        <summary style={{ cursor: "pointer" }}>Raw JSON</summary>
        <pre style={rawJsonStyle}>{JSON.stringify(entry, null, 2)}</pre>
      </details>
    </article>)}
  </section>;
}

function LoadFailure({ message }: { message: string }) {
  return <main style={pageStyle}>
    <section style={{ ...heroStyle, borderColor: "var(--destructive)" }} role="alert">
      <span style={badgeStyle("warn")}>Paperclip EE failed to load</span>
      <h1>Detailed policy editing is temporarily unavailable.</h1>
      <p style={mutedStyle}>Skill management still works in core; stored policies are enforced by the core API. Error: {message}</p>
      <div style={rowStyle}><button type="button" style={buttonStyle("primary")} onClick={() => window.location.reload()}>Retry</button><a style={buttonStyle()} href="company/settings/instance/plugins/paperclipai.paperclip-ee">Plugin settings</a></div>
    </section>
  </main>;
}

function SkillPolicyEditor() {
  const context = useHostContext();
  const toast = usePluginToast();
  const availability = usePluginData<Availability>("availability", { companyId: context.companyId });
  const companyId = context.companyId;
  const { policy, agents, audit, loading, error, refresh } = useCompanyPolicy(companyId);
  const [draft, setDraft] = useState<EffectiveSkillPolicy | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "overrides" | "simulate" | "audit">("overview");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetConfirmationOpen, setResetConfirmationOpen] = useState(false);
  const [highlightedRuleId, setHighlightedRuleId] = useState<string | null>(null);

  useEffect(() => {
    if (policy) setDraft(policy);
  }, [policy]);

  const stateBadge = useMemo(() => {
    if (!draft) return null;
    return draft.materialized ? <span style={badgeStyle(draft.defaultEffect === "deny" ? "warn" : "neutral")}>Restricted</span> : <span style={badgeStyle("neutral")}>Open default</span>;
  }, [draft]);

  useEffect(() => {
    if (activeTab !== "overrides" || !highlightedRuleId) return;
    const scheduleFrame = window.requestAnimationFrame ?? ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
    const cancelFrame = window.cancelAnimationFrame ?? ((handle: number) => window.clearTimeout(handle));
    const frame = scheduleFrame(() => document.getElementById(`rule-${highlightedRuleId}`)?.scrollIntoView?.({ block: "center" }));
    return () => cancelFrame(frame);
  }, [activeTab, highlightedRuleId]);

  if (availability.error) return <LoadFailure message={availability.error.message} />;
  if (!companyId) return <LoadFailure message="No active company context was provided." />;
  if (loading || !draft) return <main style={pageStyle}><section style={heroStyle}>Loading skill policy...</section></main>;
  if (error) return <LoadFailure message={error} />;

  async function savePolicy(nextPolicy?: EffectiveSkillPolicy) {
    const policyToSave = nextPolicy ?? draft;
    if (!companyId || !policyToSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiJson<EffectiveSkillPolicy>(`/api/companies/${encodeURIComponent(companyId)}/skill-policy`, {
        method: "PUT",
        body: JSON.stringify({ expectedRevision: policy?.revision ?? 0, schemaVersion: 1, defaultEffect: policyToSave.defaultEffect, rules: policyToSave.rules }),
      });
      toast({ tone: "success", title: "Skill policy saved", body: "The core evaluator will use the new revision immediately." });
      await refresh();
    } catch (err) {
      const status = typeof err === "object" && err && "status" in err ? (err as { status?: number }).status : null;
      setSaveError(status === 409 ? "Policy changed since you loaded it. Reload before saving this draft." : err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function resetPolicy() {
    if (!companyId) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiJson<EffectiveSkillPolicy>(`/api/companies/${encodeURIComponent(companyId)}/skill-policy`, { method: "DELETE" });
      toast({ tone: "success", title: "Skill policy reset", body: "The company is back on the unrestricted open default." });
      setResetConfirmationOpen(false);
      await refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function previewPreset(preset: Pick<EffectiveSkillPolicy, "schemaVersion" | "defaultEffect" | "rules">, tab: typeof activeTab = "overview") {
    setDraft({ ...preset, revision: policy?.revision ?? 0, materialized: preset.rules.length > 0 || preset.defaultEffect === "deny" });
    setHighlightedRuleId(null);
    setActiveTab(tab);
  }

  function openMatchedRule(ruleId: string) {
    setHighlightedRuleId(ruleId);
    setActiveTab("overrides");
  }

  return <main style={pageStyle}>
    <section style={heroStyle}>
      <div style={rowStyle}>{stateBadge}<span style={mutedStyle}>Revision {draft.revision} · {draft.materialized ? "materialized policy" : "not materialized"} · EE {availability.data?.status ?? "loading"}</span></div>
      <h1>Paperclip EE Skill Policy</h1>
      <p style={mutedStyle}>Detailed administration for per-agent, per-role, per-action, per-source, and protected-skill overrides. Enforcement stays in core; this page only edits and simulates the core policy document.</p>
      <div style={rowStyle}>
        <button style={buttonStyle("primary")} type="button" onClick={() => void savePolicy()} disabled={saving}>{saving ? "Saving..." : "Save policy"}</button>
        <button style={buttonStyle()} type="button" onClick={() => previewPreset(buildOpenPreset())}>Preview Open</button>
        <button style={buttonStyle("danger")} type="button" aria-expanded={resetConfirmationOpen} onClick={() => setResetConfirmationOpen(true)}>Reset to open default</button>
      </div>
      {resetConfirmationOpen ? <div role="alertdialog" aria-labelledby="reset-policy-title" aria-describedby="reset-policy-description" style={{ ...cardStyle, borderColor: "var(--destructive)" }}>
        <strong id="reset-policy-title">Confirm reset to open default</strong>
        <p id="reset-policy-description" style={mutedStyle}>Resetting removes the explicit policy and allows every authenticated company agent to manage skills again. Core platform safety checks still apply, but these EE restrictions will be deleted.</p>
        <div style={rowStyle}>
          <button type="button" style={buttonStyle("danger")} onClick={() => void resetPolicy()} disabled={saving}>{saving ? "Resetting..." : "Confirm reset"}</button>
          <button type="button" style={buttonStyle()} onClick={() => setResetConfirmationOpen(false)} disabled={saving}>Cancel</button>
        </div>
      </div> : null}
      {saveError ? <div role="alert" style={{ ...cardStyle, borderColor: "var(--status-task-todo)" }}>{saveError} <button type="button" style={buttonStyle()} onClick={() => void refresh()}>Reload</button></div> : null}
    </section>

    <nav style={rowStyle} aria-label="Policy editor sections">
      {(["overview", "overrides", "simulate", "audit"] as const).map((tab) => <button key={tab} type="button" style={buttonStyle(activeTab === tab ? "primary" : "secondary")} onClick={() => setActiveTab(tab)}>{tab}</button>)}
    </nav>

    {activeTab === "overview" ? <>
      <section style={sectionStyle}>
        <strong>Policy overview</strong>
        <div style={gridStyle}>
          <div><span style={mutedStyle}>Default</span><div>{draft.defaultEffect}</div></div>
          <div><span style={mutedStyle}>Rules</span><div>{draft.rules.length}</div></div>
          <div><span style={mutedStyle}>Agents available</span><div>{agents.length}</div></div>
        </div>
        {!draft.materialized ? <p style={mutedStyle}>This company uses the open default. Every authenticated company agent can manage skills unless an explicit policy is saved.</p> : null}
      </section>
      <section style={sectionStyle}>
        <strong>Safe presets</strong>
        <div style={gridStyle}>
          <PresetCard title="Open" body="Default allow, no rules. Equivalent to resetting the explicit policy." onPreview={() => previewPreset(buildOpenPreset())} />
          <PresetCard title="Restricted Authors" body="Blocks external-package and Git imports for ordinary agents while allowing administrator roles." onPreview={() => previewPreset(buildRestrictedAuthorsPreset(), "overrides")} />
          <PresetCard title="Administrators Only" body="Default deny with administrator-role allow rules for every skill action." warning="Strong lockdown" onPreview={() => previewPreset(buildAdminsOnlyPreset(), "overrides")} />
        </div>
      </section>
    </> : null}

    {activeTab === "overrides" ? <>
      <RuleEditor draft={draft} setDraft={setDraft} agents={agents} />
      <RuleTable draft={draft} setDraft={setDraft} highlightedRuleId={highlightedRuleId} />
    </> : null}

    {activeTab === "simulate" ? <SimulationPanel companyId={companyId} rules={draft.rules} onOpenRule={openMatchedRule} /> : null}
    {activeTab === "audit" ? <AuditHistory entries={audit} /> : null}
  </main>;
}

export function SkillPolicyEditorPage(_props: PluginPageProps) {
  return <SkillPolicyEditor />;
}
