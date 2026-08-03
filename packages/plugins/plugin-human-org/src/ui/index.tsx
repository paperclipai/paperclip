import { useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  useHostContext,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { HUMAN_ORG_LIMITS, SAMPLE_ORG_CHART_CSV, type HumanProfile, type OrgTreeNode } from "../model.js";

type ProjectRecord = { id: string; name: string; status?: string };
type IssueRecord = { id: string; identifier?: string | null; title: string; status: string; priority?: string | null; projectId?: string | null };

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface NewTaskRequestInput {
  companyId: string;
  humanExternalId: string;
  projectId?: string;
  title: string;
  description: string;
  priority: string;
}

export interface NewTaskRequestIdentity {
  requestId: string;
  input: NewTaskRequestInput;
}

export function resolveNewTaskRequestIdentity(
  current: NewTaskRequestIdentity | null,
  input: NewTaskRequestInput,
  nextRequestId: () => string = createRequestId,
): NewTaskRequestIdentity {
  const unchanged = current
    && current.input.companyId === input.companyId
    && current.input.humanExternalId === input.humanExternalId
    && current.input.projectId === input.projectId
    && current.input.title === input.title
    && current.input.description === input.description
    && current.input.priority === input.priority;
  return unchanged ? current : { requestId: nextRequestId(), input: { ...input } };
}

type AssignmentRecord = { issueId: string; humanExternalId: string; linkedUserId: string | null; notificationState: string };
type WorkCard = { assignment: AssignmentRecord; human: HumanProfile; issue: IssueRecord };
type RosterData = { profiles: HumanProfile[]; roots: OrgTreeNode[]; inactiveCount: number };
type BoardData = { columns: Record<string, WorkCard[]>; total: number };
type IntegrationStatus = { mattermostConfigured: boolean; notificationsEnabled: boolean; paperclipBaseUrlConfigured: boolean };
type IssueAssignmentData = { assignment: AssignmentRecord | null; human: HumanProfile | null; profiles: HumanProfile[] };

const pageStyle: CSSProperties = { display: "grid", gap: 20, padding: "4px 0 28px" };
const cardStyle: CSSProperties = { border: "1px solid var(--border)", borderRadius: 4, padding: 16, background: "var(--card, transparent)" };
const subtleStyle: CSSProperties = { border: "1px solid var(--border)", borderRadius: 4, padding: 12, background: "color-mix(in srgb, var(--card, transparent) 80%, transparent)" };
const inputStyle: CSSProperties = { width: "100%", border: "1px solid var(--border)", borderRadius: 3, padding: "9px 10px", background: "transparent", color: "inherit", boxSizing: "border-box" };
const buttonStyle: CSSProperties = { border: "1px solid var(--border)", borderRadius: 3, padding: "8px 12px", background: "transparent", color: "inherit", cursor: "pointer" };
const primaryButtonStyle: CSSProperties = { ...buttonStyle, background: "var(--foreground)", color: "var(--background)", borderColor: "var(--foreground)" };
const mutedStyle: CSSProperties = { opacity: 0.68, fontSize: 12, lineHeight: 1.5 };
const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
const gridStyle: CSSProperties = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" };

const STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section style={cardStyle}>
      <div style={{ ...rowStyle, justifyContent: "space-between", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Pills({ values }: { values: string[] }) {
  if (values.length === 0) return <span style={mutedStyle}>None listed</span>;
  return (
    <div style={rowStyle}>
      {values.map((value) => (
        <span key={value} style={{ border: "1px solid var(--border)", padding: "2px 7px", borderRadius: 999, fontSize: 11 }}>{value}</span>
      ))}
    </div>
  );
}

function OrgNode({ node, depth = 0 }: { node: OrgTreeNode; depth?: number }) {
  const profile = node.profile;
  return (
    <div style={{ display: "grid", gap: 8, marginLeft: depth === 0 ? 0 : 22, borderLeft: depth === 0 ? undefined : "1px solid var(--border)", paddingLeft: depth === 0 ? 0 : 12 }}>
      <div style={subtleStyle}>
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <div>
            <strong>{profile.name}</strong>
            <div style={mutedStyle}>{profile.title || "No title"}{profile.email ? ` · ${profile.email}` : ""}</div>
          </div>
          <span style={{ fontSize: 11, opacity: 0.7 }}>{profile.paperclipUserId ? "Paperclip ID provided" : "External human"}</span>
        </div>
        <div style={{ display: "grid", gap: 7, marginTop: 10 }}>
          <div><span style={mutedStyle}>Capabilities</span><Pills values={profile.capabilities} /></div>
          <div><span style={mutedStyle}>Responsibilities</span><Pills values={profile.responsibilities} /></div>
        </div>
      </div>
      {node.children.map((child) => <OrgNode key={child.profile.externalId} node={child} depth={depth + 1} />)}
    </div>
  );
}

function downloadSample(): void {
  const blob = new Blob([SAMPLE_ORG_CHART_CSV], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "human-org-chart-sample.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

function ImportPanel({ companyId, onImported }: { companyId: string; onImported: () => void }) {
  const importOrgChart = usePluginAction("import-org-chart");
  const [file, setFile] = useState<File | null>(null);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (file.size > HUMAN_ORG_LIMITS.importCharacters) {
        throw new Error(`Org chart files are limited to ${HUMAN_ORG_LIMITS.importCharacters.toLocaleString("en-US")} bytes`);
      }
      const text = await file.text();
      const payload = file.name.toLowerCase().endsWith(".json") ? { companyId, json: text, replace } : { companyId, csv: text, replace };
      const response = await importOrgChart(payload) as { imported?: number; deactivated?: number };
      setResult(`Imported ${response.imported ?? 0} people${response.deactivated ? `; deactivated ${response.deactivated}` : ""}.`);
      onImported();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
      <div style={mutedStyle}>Upload CSV or JSON. Required columns are <code>external_id</code> and <code>name</code>. Use <code>|</code> between capabilities and responsibilities.</div>
      <input type="file" accept=".csv,.json,text/csv,application/json" onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)} />
      <label style={{ ...rowStyle, fontSize: 12 }}>
        <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.currentTarget.checked)} />
        Deactivate people omitted from this upload
      </label>
      <div style={rowStyle}>
        <button type="submit" style={primaryButtonStyle} disabled={!file || busy}>{busy ? "Importing…" : "Validate & import"}</button>
        <button type="button" style={buttonStyle} onClick={downloadSample}>Download sample CSV</button>
      </div>
      {result ? <div style={{ color: "#22c55e", fontSize: 12 }}>{result}</div> : null}
      {error ? <div role="alert" style={{ color: "#ef4444", fontSize: 12, whiteSpace: "pre-wrap" }}>{error}</div> : null}
    </form>
  );
}

function NewTaskPanel({ companyId, profiles, projects, onCreated }: { companyId: string; profiles: HumanProfile[]; projects: ProjectRecord[]; onCreated: () => void }) {
  const createTask = usePluginAction("create-human-task");
  const [humanExternalId, setHumanExternalId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestIdentityRef = useRef<NewTaskRequestIdentity | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const requestIdentity = resolveNewTaskRequestIdentity(requestIdentityRef.current, {
        companyId,
        humanExternalId,
        projectId: projectId || undefined,
        title,
        description,
        priority,
      });
      requestIdentityRef.current = requestIdentity;
      const result = await createTask({
        ...requestIdentity.input,
        requestId: requestIdentity.requestId,
      }) as { issue?: IssueRecord; notification?: { state?: string; reason?: string } };
      requestIdentityRef.current = null;
      setMessage(`Created ${result.issue?.identifier ?? result.issue?.id ?? "task"}. Mattermost: ${result.notification?.state ?? "skipped"}.`);
      setTitle("");
      setDescription("");
      onCreated();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
      <select style={inputStyle} value={humanExternalId} onChange={(event) => setHumanExternalId(event.currentTarget.value)} required>
        <option value="">Select human owner</option>
        {profiles.map((profile) => <option key={profile.externalId} value={profile.externalId}>{profile.name} — {profile.title || "No title"}</option>)}
      </select>
      <select style={inputStyle} value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)}>
        <option value="">No project</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <input style={inputStyle} value={title} maxLength={HUMAN_ORG_LIMITS.taskTitle} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="Task title" required />
      <textarea style={{ ...inputStyle, minHeight: 90 }} value={description} maxLength={HUMAN_ORG_LIMITS.taskDescription} onChange={(event) => setDescription(event.currentTarget.value)} placeholder="Description and acceptance criteria" />
      <select style={inputStyle} value={priority} onChange={(event) => setPriority(event.currentTarget.value)}>
        <option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
      </select>
      <button type="submit" style={primaryButtonStyle} disabled={busy || !humanExternalId || !title.trim()}>{busy ? "Creating…" : "Create & assign task"}</button>
      {message ? <div style={{ color: "#22c55e", fontSize: 12 }}>{message}</div> : null}
      {error ? <div role="alert" style={{ color: "#ef4444", fontSize: 12 }}>{error}</div> : null}
    </form>
  );
}

function HumanBoard({ companyId, board, onUpdated }: { companyId: string; board: BoardData; onUpdated: () => void }) {
  const updateStatus = usePluginAction("update-human-task-status");
  const navigation = useHostNavigation();
  const [busyIssue, setBusyIssue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const statusOrder = Object.keys(STATUS_LABELS);

  async function move(issueId: string, status: string) {
    setBusyIssue(issueId);
    setError(null);
    try {
      await updateStatus({ companyId, issueId, status });
      onUpdated();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusyIssue(null);
    }
  }

  return (
    <>
      {error ? <div role="alert" style={{ color: "#ef4444", fontSize: 12, marginBottom: 10 }}>{error}</div> : null}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${statusOrder.length}, minmax(250px, 1fr))`, gap: 10, overflowX: "auto", paddingBottom: 6 }}>
        {statusOrder.map((status, index) => {
          const cards = board.columns[status] ?? [];
          return (
            <div key={status} style={{ ...subtleStyle, minHeight: 180 }}>
              <div style={{ ...rowStyle, justifyContent: "space-between", marginBottom: 10 }}><strong style={{ fontSize: 12 }}>{STATUS_LABELS[status]}</strong><span style={mutedStyle}>{cards.length}</span></div>
              <div style={{ display: "grid", gap: 8 }}>
                {cards.map(({ issue, human, assignment }) => {
                  const href = `/issues/${issue.identifier ?? issue.id}`;
                  return (
                    <article key={issue.id} style={{ ...cardStyle, padding: 11 }}>
                      <a {...navigation.linkProps(href)} style={{ color: "inherit", textDecoration: "none", fontWeight: 600, fontSize: 13 }}>{issue.title}</a>
                      <div style={{ ...mutedStyle, marginTop: 5 }}>{human.name} · {issue.priority ?? "medium"}</div>
                      <div style={{ ...mutedStyle, marginTop: 3 }}>{assignment.linkedUserId ? "Paperclip member" : "External human"} · Mattermost {assignment.notificationState}</div>
                      <div style={{ ...rowStyle, marginTop: 9 }}>
                        {index > 0 ? <button style={buttonStyle} disabled={busyIssue === issue.id} onClick={() => void move(issue.id, statusOrder[index - 1]!)}>←</button> : null}
                        {index < statusOrder.length - 1 ? <button style={buttonStyle} disabled={busyIssue === issue.id} onClick={() => void move(issue.id, statusOrder[index + 1]!)}>→</button> : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function HumanOrgPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const roster = usePluginData<RosterData>("human-roster", companyId ? { companyId } : undefined);
  const board = usePluginData<BoardData>("human-work-board", companyId ? { companyId } : undefined);
  const projects = usePluginData<ProjectRecord[]>("projects", companyId ? { companyId } : undefined);
  const integration = usePluginData<IntegrationStatus>("integration-status", companyId ? { companyId } : undefined);
  const profiles = roster.data?.profiles ?? [];
  const capabilityCount = useMemo(() => new Set(profiles.flatMap((profile) => profile.capabilities)).size, [profiles]);

  if (!companyId) return <div style={cardStyle}>Select a company to use Human Org & Work.</div>;
  const refreshAll = () => { roster.refresh(); board.refresh(); projects.refresh(); integration.refresh(); };

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={{ margin: 0, fontSize: 24 }}>Human Org & Work</h1>
        <p style={{ ...mutedStyle, maxWidth: 760 }}>Import human reporting lines, capabilities, and responsibilities. Create real Paperclip issues, manage them on the human work board, and notify assignees in Mattermost.</p>
      </header>

      <div style={gridStyle}>
        <div style={subtleStyle}><strong>{profiles.length}</strong><div style={mutedStyle}>Active people</div></div>
        <div style={subtleStyle}><strong>{capabilityCount}</strong><div style={mutedStyle}>Unique capabilities</div></div>
        <div style={subtleStyle}><strong>{board.data?.total ?? 0}</strong><div style={mutedStyle}>Human-assigned tasks</div></div>
        <div style={subtleStyle}><strong>{integration.data?.mattermostConfigured ? "Connected" : "Not configured"}</strong><div style={mutedStyle}>Mattermost notifications</div></div>
      </div>

      <div style={{ ...subtleStyle, borderColor: integration.data?.mattermostConfigured ? "#22c55e" : "#d97706" }}>
        <strong>Mattermost: {integration.data?.mattermostConfigured ? "ready" : "setup required"}</strong>
        <div style={mutedStyle}>Configure the incoming webhook as a Secret in the plugin’s company configuration. Tasks remain authoritative in Paperclip; Mattermost is the notification and collaboration surface.</div>
      </div>

      <div style={gridStyle}>
        <Section title="Import org chart"><ImportPanel companyId={companyId} onImported={refreshAll} /></Section>
        <Section title="Create human task"><NewTaskPanel companyId={companyId} profiles={profiles} projects={projects.data ?? []} onCreated={refreshAll} /></Section>
      </div>

      <Section title="Human work board" action={<button style={buttonStyle} onClick={refreshAll}>Refresh</button>}>
        {board.loading ? <div style={mutedStyle}>Loading board…</div> : board.data ? <HumanBoard companyId={companyId} board={board.data} onUpdated={refreshAll} /> : <div style={mutedStyle}>No human assignments yet.</div>}
      </Section>

      <Section title="Human org chart">
        {roster.loading ? <div style={mutedStyle}>Loading roster…</div> : roster.data?.roots.length ? (
          <div style={{ display: "grid", gap: 12 }}>{roster.data.roots.map((root) => <OrgNode key={root.profile.externalId} node={root} />)}</div>
        ) : <div style={mutedStyle}>Upload a CSV or JSON org chart to begin.</div>}
      </Section>
    </main>
  );
}

export function HumanOrgSidebarLink() {
  const navigation = useHostNavigation();
  return <a {...navigation.linkProps("/human-org")} style={{ color: "inherit", textDecoration: "none" }}>Human Org & Work</a>;
}

export function HumanTaskDetailView() {
  const context = useHostContext();
  const companyId = context.companyId;
  const issueId = context.entityId;
  const details = usePluginData<IssueAssignmentData>("issue-human-assignment", companyId && issueId ? { companyId, issueId } : undefined);
  const assign = usePluginAction("assign-human-task");
  const unassign = usePluginAction("unassign-human-task");
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!companyId || !issueId) return null;
  const current = details.data?.human;
  async function assignSelected() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await assign({ companyId, issueId, humanExternalId: selected });
      setSelected("");
      details.refresh();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }
  async function clearAssignment() {
    setBusy(true);
    setError(null);
    try {
      await unassign({ companyId, issueId });
      details.refresh();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ ...cardStyle, display: "grid", gap: 10 }}>
      <div>
        <strong>Human assignment</strong>
        <div style={mutedStyle}>{current ? `${current.name} · ${current.title || "No title"}` : "No imported human is assigned."}</div>
      </div>
      {current ? <Pills values={current.capabilities} /> : null}
      <select style={inputStyle} value={selected} onChange={(event) => setSelected(event.currentTarget.value)}>
        <option value="">Choose imported human</option>
        {(details.data?.profiles ?? []).map((profile) => <option key={profile.externalId} value={profile.externalId}>{profile.name} — {profile.title || "No title"}</option>)}
      </select>
      <div style={rowStyle}>
        <button style={primaryButtonStyle} disabled={!selected || busy} onClick={() => void assignSelected()}>{busy ? "Saving…" : "Assign & notify"}</button>
        {current ? <button style={buttonStyle} disabled={busy} onClick={() => void clearAssignment()}>Remove</button> : null}
      </div>
      {error ? <div role="alert" style={{ color: "#ef4444", fontSize: 12 }}>{error}</div> : null}
    </div>
  );
}
