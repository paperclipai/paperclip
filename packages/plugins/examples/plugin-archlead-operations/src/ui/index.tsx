import {
  useHostNavigation,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { useState, useEffect, type CSSProperties, type FormEvent, type ReactNode } from "react";

type PluginRecord = {
  id: string;
  externalId: string | null;
  title: string | null;
  status: string | null;
  data: Record<string, unknown>;
  createdAt: string;
};

type PaymentReceipt = {
  event_id: string;
  provider: string;
  resource_id: string;
  payment_status: string;
  received_at: string;
};

type QualificationTask = PluginRecord & {
  issueId: string | null;
  interactionId: string | null;
  issueTitle: string | null;
  issueStatus: string | null;
  interactionStatus: string | null;
  qualificationStatus: "pending_review" | "qualified" | "disqualified";
  approvalStatus: "required" | "approved" | "rejected";
  outreachStatus: "blocked";
};

type Overview = {
  pluginId: string;
  leads: PluginRecord[];
  requests: PluginRecord[];
  clients: PluginRecord[];
  tickets: PluginRecord[];
  qualificationTasks: QualificationTask[];
  pipelineValue: number;
  attribution: Record<string, number>;
  paymentReceipts: PaymentReceipt[];
  manualOnlyJobs: Array<{ jobKey: string; displayName: string }>;
  totals?: {
    leads: number;
    requests: number;
    clients: number;
    tickets: number;
    qualificationTasks: number;
    isLimited: boolean;
  };
  pagination?: {
    limit: number;
    offset: number;
    hasMore: {
      leads: boolean;
      requests: boolean;
      clients: boolean;
      tickets: boolean;
      qualificationTasks: boolean;
    };
  };
  isLimited?: boolean;
};

type Operation = "create-lead" | "create-request" | "create-client" | "update-record" | "convert-request";

const cardStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  background: "var(--card)",
  color: "var(--card-foreground)",
  padding: "16px",
};

const mutedStyle: CSSProperties = { color: "var(--muted-foreground)", fontSize: "0.875rem" };
const inputStyle: CSSProperties = {
  minWidth: 0,
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  background: "var(--background)",
  color: "var(--foreground)",
  padding: "8px",
};
const primaryButtonStyle: CSSProperties = {
  border: "1px solid var(--primary)",
  borderRadius: "var(--radius)",
  background: "var(--primary)",
  color: "var(--primary-foreground)",
  padding: "8px 12px",
  cursor: "pointer",
};
const secondaryButtonStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  background: "var(--secondary)",
  color: "var(--secondary-foreground)",
  padding: "6px 9px",
  cursor: "pointer",
};
const tableStyle: CSSProperties = { borderCollapse: "collapse", minWidth: "680px", width: "100%", textAlign: "left" };

const REQUEST_STATUSES = ["open", "qualified", "proposal", "closed_won", "closed_lost"];
const CLIENT_STATUSES = ["pending", "active", "paused"];
const TICKET_STATUSES = ["open", "needs_human", "in_progress", "waiting_on_customer", "resolved"];

function value(record: PluginRecord, key: string, fallback = ""): string {
  const field = record.data[key];
  return typeof field === "string" && field.length > 0 ? field : fallback;
}

function sortNewest(records: PluginRecord[]): PluginRecord[] {
  return [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function ArchLeadOperationsPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const { data, loading, error, refresh } = usePluginData<Overview>("overview", companyId ? { companyId } : {});
  const hostNavigation = useHostNavigation();
  const mutate = usePluginAction("admin-mutation");
  const createFollowUpIssue = usePluginAction("create-follow-up-issue");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingLeadId, setPendingLeadId] = useState<string | null>(null);

  useEffect(() => {
    const handleFocus = () => {
      void refresh();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh]);

  async function runAction(action: () => Promise<unknown>, successMessage: string): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    setFeedback(null);
    try {
      await action();
      setFeedback(successMessage);
      try {
        await refresh();
      } catch (err) {
        setActionError(`Saved, but the updated records could not be loaded: ${err instanceof Error ? err.message : "refresh failed"}`);
      }
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "The operation failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(
    event: FormEvent<HTMLFormElement>,
    operation: Operation,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!companyId) return;
    const fields = readFormFields(form);
    const externalId = globalThis.crypto?.randomUUID?.();
    if (!externalId) {
      setActionError("This browser cannot create a secure record ID.");
      return;
    }
    const payload = {
      ...fields,
      externalId,
      companyId,
      ...(operation === "create-request" && fields.value !== undefined
        ? { value: fields.value === "" ? 0 : Number(fields.value) }
        : {}),
    };
    const succeeded = await runAction(
      () => mutate({ ...payload, operation }),
      operation === "create-lead" ? "Lead and CRM request created."
        : operation === "create-request" ? "CRM request created."
          : operation === "create-client" ? "Client record created; manual onboarding is still required."
            : "Record saved.",
    );
    if (succeeded) form.reset();
  }

  async function submitSandboxQualification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!companyId) return;
    const fields = readFormFields(form);
    const id = pendingLeadId ?? `sandbox:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    setPendingLeadId(id);
    const succeeded = await runAction(
      () => mutate({
        operation: "create-sandbox-qualification",
        companyId,
        sandbox: true,
        externalLeadId: id,
        lead: {
          name: fields.name,
          email: fields.email,
          business: fields.business,
          message: fields.message,
          source: "sandbox",
        },
      }),
      "Sandbox qualification task created in Paperclip. No outreach was sent.",
    );
    if (succeeded) {
      setPendingLeadId(null);
      form.reset();
    }
  }

  async function retryQualificationTask(task: QualificationTask) {
    if (!companyId || !task.externalId) return;
    await runAction(
      () => mutate({
        operation: "create-sandbox-qualification",
        companyId,
        sandbox: true,
        externalLeadId: task.externalId,
        lead: {
          name: value(task, "name", task.title?.replace("[SANDBOX] Review lead: ", "") ?? "Synthetic Contact"),
          email: value(task, "email", "contact@example.test"),
          business: value(task, "business", "[SANDBOX] Synthetic Business"),
          message: value(task, "message", "Synthetic qualification request"),
          source: "sandbox",
        },
      }),
      "Qualification task recovered successfully.",
    );
  }

  async function updateStatus(record: PluginRecord, entityType: string, status: string) {
    if (!companyId || !record.externalId) return;
    await runAction(
      () => mutate({
        operation: "update-record",
        companyId,
        entityType,
        externalId: record.externalId,
        patch: { status },
      }),
      "Record status updated.",
    );
  }

  async function updateRecord(record: PluginRecord, entityType: string, patch: Record<string, unknown>) {
    if (!companyId || !record.externalId) return;
    await runAction(
      () => mutate({
        operation: "update-record",
        companyId,
        entityType,
        externalId: record.externalId,
        patch,
      }),
      "Record details updated.",
    );
  }

  async function convertRequest(record: PluginRecord) {
    if (!companyId || !record.externalId) return;
    await runAction(
      () => mutate({
        operation: "convert-request",
        companyId,
        externalId: record.externalId,
      }),
      "Won request converted to a pending client record.",
    );
  }

  async function createIssue(record: PluginRecord, entityType: string) {
    if (!companyId || !record.externalId) return;
    await runAction(
      () => createFollowUpIssue({ companyId, entityType, externalId: record.externalId }),
      "Paperclip follow-up task created or linked.",
    );
  }

  if (!companyId) {
    return <main style={cardStyle}><h1>ArchLead Operations</h1><p>Select a company to view its CRM and support records.</p></main>;
  }

  const leads = sortNewest(data?.leads ?? []);
  const requests = sortNewest(data?.requests ?? []);
  const clients = sortNewest(data?.clients ?? []);
  const tickets = sortNewest(data?.tickets ?? []);
  const qualificationTasks = [...(data?.qualificationTasks ?? [])]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <main style={{ display: "grid", gap: "14px", padding: "20px", maxWidth: "1440px", margin: "0 auto" }}>
      <header>
        <p style={{ ...mutedStyle, margin: 0 }}>Company-scoped CRM and support operations</p>
        <h1 style={{ fontSize: "1.5rem", margin: "4px 0 0" }}>ArchLead Operations</h1>
      </header>

      <section style={{ ...cardStyle, display: "grid", gap: "8px" }}>
        <h2 style={{ margin: 0, fontSize: "1rem" }}>Migration boundary</h2>
        <p style={{ ...mutedStyle, margin: 0 }}>
          Leads, CRM requests, client records, onboarding status, and support tickets are stored as company-scoped
          Paperclip plugin entities. Won requests can become pending client records; no external customer account is
          provisioned and no email or support alert is sent.
        </p>
        <p style={{ ...mutedStyle, margin: 0 }}>
          Public lead/support intake is signed and replay-safe. Follow-up tasks are created in the Paperclip issue
          tracker only when an operator requests one.
        </p>
      </section>

      <section style={{ ...cardStyle, display: "grid", gap: "10px" }}>
        <h2 style={{ margin: 0, fontSize: "1rem" }}>Sandbox lead qualification</h2>
        <p style={{ ...mutedStyle, margin: 0 }}>
          This creates a synthetic Paperclip issue and a native human confirmation. Only <code>@example.test</code> emails
          are accepted. Approval records qualification; all outreach remains blocked here.
        </p>
        <CreateForm title="Create sandbox lead task" onSubmit={(event) => void submitSandboxQualification(event)} busy={busy} submitLabel="Create sandbox task">
          <Field label="Synthetic contact name" name="name" required />
          <Field label="Synthetic email (@example.test only)" name="email" type="email" required placeholder="lead@example.test" />
          <Field label="Synthetic business" name="business" />
          <Field label="Qualification summary" name="message" />
        </CreateForm>
        <section>
          <h3 style={{ margin: "4px 0 8px", fontSize: "0.9rem" }}>Qualification lifecycle ({qualificationTasks.length})</h3>
          {qualificationTasks.length === 0
            ? <p style={mutedStyle}>No sandbox qualification tasks yet.</p>
            : (
              <div style={{ overflowX: "auto" }}>
                <table style={tableStyle}>
                  <thead><tr>{["Synthetic lead", "Qualification", "Human approval", "Outreach", "Paperclip issue"].map((column) => <th key={column} style={{ borderTop: "1px solid var(--border)", padding: "8px 10px", color: "var(--muted-foreground)", fontSize: "0.75rem", fontWeight: 500 }}>{column}</th>)}</tr></thead>
                  <tbody>{qualificationTasks.map((task) => (
                    <tr key={task.id}>
                      <Cell>{task.title ?? "Synthetic lead"}<Small>{value(task, "email")}</Small></Cell>
                      <Cell>{task.qualificationStatus}</Cell>
                      <Cell>{task.approvalStatus}<Small>Paperclip confirmation: {task.interactionStatus ?? "unavailable"}.</Small></Cell>
                      <Cell>{task.outreachStatus}<Small>No provider execution is enabled.</Small></Cell>
                      <Cell>
                        {task.issueId ? (
                          <>
                            <a {...hostNavigation.linkProps(`/issues/${encodeURIComponent(task.issueId)}`)}>Open issue</a>
                            <Small>{task.issueTitle ?? task.issueId} · {task.issueStatus ?? "unavailable"}</Small>
                          </>
                        ) : (
                          <div>
                            <div style={{ color: "var(--destructive)", fontSize: "0.75rem", marginBottom: "4px" }}>
                              Issue creation incomplete.
                            </div>
                            <button
                              type="button"
                              style={{ ...secondaryButtonStyle, marginTop: "4px", fontSize: "0.75rem", padding: "3px 8px" }}
                              disabled={busy}
                              onClick={() => void retryQualificationTask(task)}
                            >
                              Retry recovery
                            </button>
                          </div>
                        )}
                      </Cell>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
        </section>
      </section>

      {actionError && <p role="alert" style={{ color: "var(--destructive)", margin: 0 }}>{actionError}</p>}
      {feedback && <p role="status" style={{ color: "var(--primary)", margin: 0 }}>{feedback}</p>}
      {loading && <p role="status" style={mutedStyle}>Loading company records…</p>}
      {error && <p role="alert" style={{ color: "var(--destructive)" }}>Could not load ArchLead records: {error.message}</p>}

      {data && (
        <>
          {data.isLimited && (
            <div style={{ ...cardStyle, background: "var(--muted)", padding: "10px 14px", fontSize: "0.85rem" }}>
              <strong>Limited overview:</strong> Showing the first 200 records per CRM/support type (50 for qualifications). Counts represent the visible working set.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px" }}>
            <Metric
              label="Leads"
              count={data.totals?.leads ?? leads.length}
              subtext={data.pagination?.hasMore?.leads ? "Showing first 200 (limited view)" : undefined}
            />
            <Metric
              label="CRM requests"
              count={data.totals?.requests ?? requests.length}
              subtext={data.pagination?.hasMore?.requests ? "Showing first 200 (limited view)" : undefined}
            />
            <Metric
              label="Clients"
              count={data.totals?.clients ?? clients.length}
              subtext={data.pagination?.hasMore?.clients ? "Showing first 200 (limited view)" : undefined}
            />
            <Metric
              label="Open support tickets"
              count={tickets.filter((ticket) => ticket.status !== "resolved").length}
              subtext={data.pagination?.hasMore?.tickets ? "From first 200 visible" : undefined}
            />
            <Metric
              label="Entered pipeline value"
              count={data.pipelineValue}
              subtext={data.pagination?.hasMore?.requests ? "From first 200 visible requests" : undefined}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: "12px" }}>
            <CreateForm title="Add lead" onSubmit={(event) => void submit(event, "create-lead")} busy={busy}>
              <Field label="Contact name" name="name" required />
              <Field label="Email" name="email" type="email" required />
              <Field label="Business" name="business" />
              <Field label="Source" name="source" placeholder="website, referral, ..." />
              <Field label="Brief" name="message" />
            </CreateForm>
            <CreateForm title="Add CRM request" onSubmit={(event) => void submit(event, "create-request")} busy={busy}>
              <Field label="Business" name="business" required />
              <Field label="Contact name" name="contactName" />
              <Field label="Email" name="email" type="email" />
              <Field label="Request details" name="message" required />
              <Field label="Pipeline value" name="value" type="number" min="0" step="0.01" />
            </CreateForm>
            <CreateForm title="Add client record" onSubmit={(event) => void submit(event, "create-client")} busy={busy}>
              <Field label="Business" name="business" required />
              <Field label="Email" name="email" type="email" required />
              <Field label="Phone" name="phone" />
              <Field label="City" name="city" />
              <Field label="Plan" name="plan" />
            </CreateForm>
          </div>

          <RecordSection title="Leads" records={leads} empty="No leads have been received." columns={["Contact", "Business", "Source", "Created"]}>
            {(record) => (
              <tr key={record.id}>
                <Cell>{record.title ?? "Untitled"}<Small>{value(record, "email")}</Small></Cell>
                <Cell>{value(record, "business", "—")}</Cell>
                <Cell>{value(record, "source", "—")}</Cell>
                <Cell>{formatTime(record.createdAt)}</Cell>
              </tr>
            )}
          </RecordSection>

          <RecordSection title="CRM requests" records={requests} empty="No CRM requests have been received." columns={["Business / contact", "Request", "Stage", "Value", "Actions"]}>
            {(record) => (
              <tr key={record.id}>
                <Cell>{value(record, "business", record.title ?? "Untitled")}<Small>{value(record, "contactName")} {value(record, "email")}</Small></Cell>
                <Cell>{value(record, "message", "—")}</Cell>
                <Cell>
                  <StatusSelect record={record} entityType="archlead-request" options={REQUEST_STATUSES} onChange={(status) => void updateStatus(record, "archlead-request", status)} disabled={busy} />
                </Cell>
                <Cell>{typeof record.data.value === "number" && record.data.value > 0 ? record.data.value.toLocaleString() : "—"}</Cell>
                <Cell>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {record.status === "closed_won" && !record.data.clientExternalId && (
                      <button type="button" style={secondaryButtonStyle} disabled={busy} onClick={() => void convertRequest(record)}>Create client</button>
                    )}
                    <button type="button" style={secondaryButtonStyle} disabled={busy} onClick={() => void createIssue(record, "archlead-request")}>
                      {record.data.paperclipIssueId ? "Check Paperclip task" : "Create Paperclip task"}
                    </button>
                  </div>
                  {typeof record.data.paperclipIssueId === "string" && <Small>Task {record.data.paperclipIssueId}</Small>}
                  {value(record, "onboardingStatus") === "manual_setup_required" && <Small>Manual onboarding required; no account provisioned.</Small>}
                </Cell>
              </tr>
            )}
          </RecordSection>

          <RecordSection title="Clients & onboarding" records={clients} empty="No client records have been created." columns={["Business / contact", "Plan", "Status", "Onboarding"]}>
            {(record) => (
              <tr key={record.id}>
                <Cell>{value(record, "business", record.title ?? "Untitled")}<Small>{value(record, "email")}</Small></Cell>
                <Cell>{value(record, "plan", "Standard")}<Small>{value(record, "city")}</Small></Cell>
                <Cell>
                  <StatusSelect record={record} entityType="archlead-client" options={CLIENT_STATUSES} onChange={(status) => void updateStatus(record, "archlead-client", status)} disabled={busy} />
                </Cell>
                <Cell>
                  {value(record, "onboardingStatus", "manual_setup_required")}
                  {record.status === "active" && <Small>Active status was set by an operator; external account setup is not verified here.</Small>}
                </Cell>
              </tr>
            )}
          </RecordSection>

          <RecordSection title="Support tickets" records={tickets} empty="No support tickets have been received." columns={["Ticket / requester", "Message", "Priority", "Status", "Triage / actions"]}>
            {(record) => (
              <tr key={record.id}>
                <Cell>{record.title ?? "Support ticket"}<Small>{value(record, "name")} · {value(record, "email")}</Small></Cell>
                <Cell>{value(record, "message", "—")}</Cell>
                <Cell>
                  <select
                    aria-label={`Ticket priority for ${record.title ?? record.externalId ?? record.id}`}
                    value={value(record, "priority", "normal")}
                    onChange={(event) => void updateRecord(record, "archlead-support-ticket", { priority: event.currentTarget.value })}
                    disabled={busy}
                    style={{ ...inputStyle, minWidth: "110px", padding: "6px" }}
                  >
                    <option value="normal">normal</option>
                    <option value="high">high</option>
                  </select>
                </Cell>
                <Cell>
                  <StatusSelect record={record} entityType="archlead-support-ticket" options={TICKET_STATUSES} onChange={(status) => void updateStatus(record, "archlead-support-ticket", status)} disabled={busy} />
                </Cell>
                <Cell>
                  <TicketTriageForm
                    record={record}
                    busy={busy}
                    onSave={(patch) => void updateRecord(record, "archlead-support-ticket", patch)}
                  />
                  <button type="button" style={secondaryButtonStyle} disabled={busy} onClick={() => void createIssue(record, "archlead-support-ticket")}>
                    {record.data.paperclipIssueId ? "Check Paperclip task" : "Create Paperclip task"}
                  </button>
                  {typeof record.data.paperclipIssueId === "string" && <Small>Task {record.data.paperclipIssueId}</Small>}
                </Cell>
              </tr>
            )}
          </RecordSection>

          <section style={cardStyle}>
            <h2 style={{ marginTop: 0, fontSize: "1rem" }}>Attribution by last touch</h2>
            {Object.keys(data.attribution).length === 0
              ? <p style={mutedStyle}>No CRM attribution has been recorded.</p>
              : <ul style={{ margin: 0, paddingLeft: "20px" }}>{Object.entries(data.attribution).map(([source, count]) => <li key={source}>{source}: {count}</li>)}</ul>}
            <Small>Pipeline value is the sum of operator-entered request values; no default quote is inferred.</Small>
          </section>

          <section style={cardStyle}>
            <h2 style={{ marginTop: 0, fontSize: "1rem" }}>Signed payment event receipts</h2>
            <p style={mutedStyle}>Verified receipts update only a local payment-order status; they do not confirm invoices, trigger fulfillment, or provision customers.</p>
            {data.paymentReceipts.length === 0
              ? <p style={mutedStyle}>No verified payment events have been received.</p>
              : <ul style={{ margin: 0, paddingLeft: "20px" }}>{data.paymentReceipts.map((receipt) => (
                <li key={`${receipt.event_id}-${receipt.received_at}`} style={{ marginBottom: "6px" }}>
                  {receipt.provider} · {receipt.payment_status} · {receipt.resource_id}
                </li>
              ))}</ul>}
          </section>

          <section style={cardStyle}>
            <h2 style={{ marginTop: 0, fontSize: "1rem" }}>Manual-only operation hooks</h2>
            <p style={mutedStyle}>These hooks remain disabled until their integrations are ported; Paperclip does not start a duplicate ArchLead scheduler.</p>
            <ul style={{ columns: 2, margin: 0, paddingLeft: "20px" }}>
              {data.manualOnlyJobs.map((job) => <li key={job.jobKey}>{job.displayName}</li>)}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}

function Metric({ label, count, subtext }: { label: string; count: number | string; subtext?: string }) {
  return (
    <section style={cardStyle}>
      <div style={mutedStyle}>{label}</div>
      <strong style={{ display: "block", fontSize: "1.35rem", marginTop: "4px" }}>
        {typeof count === "number" ? count.toLocaleString() : count}
      </strong>
      {subtext && <div style={{ ...mutedStyle, fontSize: "0.75rem", marginTop: "2px" }}>{subtext}</div>}
    </section>
  );
}

function CreateForm({
  title,
  onSubmit,
  busy,
  submitLabel = "Save record",
  children,
}: {
  title: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  busy: boolean;
  submitLabel?: string;
  children: ReactNode;
}) {
  return (
    <form onSubmit={onSubmit} style={{ ...cardStyle, display: "grid", gap: "10px", alignContent: "start" }}>
      <h2 style={{ margin: 0, fontSize: "1rem" }}>{title}</h2>
      <div style={{ display: "grid", gap: "8px" }}>{children}</div>
      <button type="submit" style={primaryButtonStyle} disabled={busy}>{busy ? "Saving…" : submitLabel}</button>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  required = false,
  placeholder,
  min,
  step,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  min?: string;
  step?: string;
}) {
  return (
    <label style={{ display: "grid", gap: "4px", fontSize: "0.75rem", color: "var(--muted-foreground)" }}>
      {label}
      <input style={inputStyle} name={name} type={type} required={required} placeholder={placeholder} min={min} step={step} />
    </label>
  );
}

function RecordSection({
  title,
  records,
  empty,
  columns,
  children,
}: {
  title: string;
  records: PluginRecord[];
  empty: string;
  columns: string[];
  children: (record: PluginRecord) => ReactNode;
}) {
  return (
    <section style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
      <h2 style={{ fontSize: "1rem", margin: 0, padding: "14px 16px" }}>{title} <span style={mutedStyle}>({records.length})</span></h2>
      {records.length === 0
        ? <p style={{ ...mutedStyle, padding: "0 16px 14px" }}>{empty}</p>
        : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead><tr>{columns.map((column) => <th key={column} style={{ borderTop: "1px solid var(--border)", padding: "8px 10px", color: "var(--muted-foreground)", fontSize: "0.75rem", fontWeight: 500 }}>{column}</th>)}</tr></thead>
              <tbody>{records.map((record) => children(record))}</tbody>
            </table>
          </div>
        )}
    </section>
  );
}

function Cell({ children }: { children: ReactNode }) {
  return <td style={{ borderTop: "1px solid var(--border)", padding: "9px 10px", verticalAlign: "top", fontSize: "0.8125rem", maxWidth: "420px", overflowWrap: "anywhere" }}>{children}</td>;
}

function Small({ children }: { children: ReactNode }) {
  return <span style={{ display: "block", color: "var(--muted-foreground)", fontSize: "0.75rem", marginTop: "3px" }}>{children}</span>;
}

function StatusSelect({
  record,
  entityType,
  options,
  onChange,
  disabled,
}: {
  record: PluginRecord;
  entityType: string;
  options: string[];
  onChange: (status: string) => void;
  disabled: boolean;
}) {
  return (
    <select
      aria-label={`${entityType} status for ${record.title ?? record.externalId ?? record.id}`}
      value={record.status ?? options[0]}
      onChange={(event) => onChange(event.currentTarget.value)}
      disabled={disabled}
      style={{ ...inputStyle, minWidth: "150px", padding: "6px" }}
    >
      {options.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}
    </select>
  );
}

function TicketTriageForm({
  record,
  busy,
  onSave,
}: {
  record: PluginRecord;
  busy: boolean;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    onSave(readFormFields(form));
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: "6px", marginBottom: "8px" }}>
      <label style={{ display: "grid", gap: "3px", fontSize: "0.75rem", color: "var(--muted-foreground)" }}>
        Assigned to
        <input style={inputStyle} name="assignedTo" defaultValue={value(record, "assignedTo")} />
      </label>
      <label style={{ display: "grid", gap: "3px", fontSize: "0.75rem", color: "var(--muted-foreground)" }}>
        Resolution / operator note
        <textarea style={{ ...inputStyle, minHeight: "56px", resize: "vertical" }} name="resolution" defaultValue={value(record, "resolution")} />
      </label>
      <button type="submit" style={secondaryButtonStyle} disabled={busy}>Save triage</button>
    </form>
  );
}

function readFormFields(form: HTMLFormElement): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let index = 0; index < form.elements.length; index += 1) {
    const control = form.elements.item(index);
    if (
      control
      && (control instanceof HTMLInputElement
        || control instanceof HTMLSelectElement
        || control instanceof HTMLTextAreaElement)
      && control.name
    ) {
      fields[control.name] = control.value;
    }
  }
  return fields;
}
