import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { ACTION_KEYS, DATA_KEYS } from "../constants.js";

type LatestMarkdown = { createdAt: string; markdown: string };

type OverviewData = {
  companyId: string;
  companyName: string;
  projects: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string; status: string; role: string }>;
  leadPipeline: Array<{
    issueId?: string;
    leadName: string;
    organization?: string;
    stage: string;
    score: number;
    nextStep?: string;
    nextFollowUp?: string | null;
    updatedAt: string;
    summary?: string;
    source?: string;
  }>;
  recentRecords: Array<{ id: string; kind: string; title: string; createdAt: string; summary?: string }>;
  latestDailyBrief: LatestMarkdown | null;
  latestProposalDraft: (LatestMarkdown & { title: string }) | null;
  latestEmailReply: (LatestMarkdown & { subject: string }) | null;
  latestFocusPlan: (LatestMarkdown & { date: string }) | null;
  latestMissionControlPlan: (LatestMarkdown & { objective: string }) | null;
  latestContentCampaign: (LatestMarkdown & { title: string }) | null;
  latestWatchdogReport: LatestMarkdown | null;
  openIssues: Array<{ id: string; title: string; status: string }>;
  activeGoals: Array<{ id: string; title: string; status: string }>;
  counts: {
    records: number;
    openIssues: number;
    activeGoals: number;
    projects: number;
    agents: number;
    leadPipeline: number;
    followUpsDue: number;
  };
};

const LEAD_STAGES = ["new", "qualified", "nurture", "proposal", "negotiation", "won", "lost"] as const;

const stack: CSSProperties = { display: "grid", gap: 12 };
const card: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 14,
  background: "var(--card, transparent)",
};
const grid: CSSProperties = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" };
const artifactGrid: CSSProperties = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" };
const input: CSSProperties = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "8px 10px",
  background: "transparent",
  color: "inherit",
};
const textarea: CSSProperties = { ...input, minHeight: 110, fontFamily: "inherit", resize: "vertical" };
const button: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 999,
  padding: "8px 12px",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
};
const primaryButton: CSSProperties = { ...button, background: "var(--foreground)", color: "var(--background)", borderColor: "var(--foreground)" };
const subtleButton: CSSProperties = { ...button, fontSize: 12 };
const codeBlock: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 12,
  background: "color-mix(in srgb, var(--muted, #999) 16%, transparent)",
  fontSize: 12,
  lineHeight: 1.5,
};
const miniLabel: CSSProperties = { opacity: 0.7, fontSize: 12 };
const labelStack: CSSProperties = { display: "grid", gap: 6 };
const checkboxRow: CSSProperties = { display: "flex", gap: 8, alignItems: "center", fontSize: 13 };

function JsonLike({ value }: { value: unknown }) {
  return <pre style={codeBlock}>{JSON.stringify(value, null, 2)}</pre>;
}

function splitCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function useOverview(companyId: string | null | undefined, refreshKey: number) {
  return usePluginData<OverviewData | null>(DATA_KEYS.overview, companyId ? { companyId, refreshKey } : { refreshKey });
}

function useProjectOptions(data: OverviewData | null | undefined) {
  return useMemo(() => data?.projects ?? [], [data]);
}

function Label({ title, children }: { title: string; children: ReactNode }) {
  return (
    <label style={labelStack}>
      <span style={miniLabel}>{title}</span>
      {children}
    </label>
  );
}

function ProjectSelect({
  value,
  onChange,
  projects,
}: {
  value: string;
  onChange: (value: string) => void;
  projects: Array<{ id: string; name: string }>;
}) {
  return (
    <select style={input} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">No project override</option>
      {projects.map((project) => (
        <option key={project.id} value={project.id}>{project.name}</option>
      ))}
    </select>
  );
}

function ArtifactCard({ title, subtitle, artifact, emptyMessage }: { title: string; subtitle?: string; artifact: LatestMarkdown | null; emptyMessage: string }) {
  return (
    <section style={card}>
      <div style={{ display: "grid", gap: 4, marginBottom: 10 }}>
        <strong>{title}</strong>
        {subtitle ? <div style={miniLabel}>{subtitle}</div> : null}
        {artifact ? <div style={miniLabel}>Updated {artifact.createdAt}</div> : null}
      </div>
      {artifact ? <pre style={codeBlock}>{artifact.markdown}</pre> : <div style={miniLabel}>{emptyMessage}</div>}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div style={miniLabel}>{label}</div>
      <div>{value}</div>
    </div>
  );
}

export function BusinessWorkflowsDashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = useOverview(context.companyId, 0);

  if (!context.companyId) return <section style={card}>Select a company to use Business Workflows.</section>;
  if (loading) return <section style={card}>Loading workflow overview…</section>;
  if (error) return <section style={card}>Plugin error: {error.message}</section>;

  return (
    <section style={{ ...card, ...stack }}>
      <strong>Business Workflows</strong>
      <div style={grid}>
        <Stat label="Workflow records" value={data?.counts.records ?? 0} />
        <Stat label="Open issues" value={data?.counts.openIssues ?? 0} />
        <Stat label="Active goals" value={data?.counts.activeGoals ?? 0} />
        <Stat label="Pipeline entries" value={data?.counts.leadPipeline ?? 0} />
        <Stat label="Follow-ups due" value={data?.counts.followUpsDue ?? 0} />
        <Stat label="Agents" value={data?.counts.agents ?? 0} />
      </div>
      <div style={{ fontSize: 12, opacity: 0.8 }}>
        {data?.latestDailyBrief ? `Latest brief: ${data.latestDailyBrief.createdAt}` : "No brief generated yet."}
      </div>
      <div style={{ fontSize: 12, opacity: 0.8 }}>
        {data?.latestWatchdogReport ? `Latest watchdog: ${data.latestWatchdogReport.createdAt}` : "No watchdog report yet."}
      </div>
    </section>
  );
}

export function BusinessWorkflowsPage(_props: PluginPageProps) {
  const host = useHostContext();
  const companyId = host.companyId;
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, loading, error } = useOverview(companyId, refreshKey);
  const projects = useProjectOptions(data ?? undefined);

  const ingestMeetingTranscript = usePluginAction(ACTION_KEYS.ingestMeetingTranscript);
  const generateProposalDraft = usePluginAction(ACTION_KEYS.generateProposalDraft);
  const ingestEmailThread = usePluginAction(ACTION_KEYS.ingestEmailThread);
  const generateEmailReply = usePluginAction(ACTION_KEYS.generateEmailReply);
  const ingestCalendarEvent = usePluginAction(ACTION_KEYS.ingestCalendarEvent);
  const planFocusBlocks = usePluginAction(ACTION_KEYS.planFocusBlocks);
  const ingestLead = usePluginAction(ACTION_KEYS.ingestLead);
  const updateLeadPipeline = usePluginAction(ACTION_KEYS.updateLeadPipeline);
  const queueContentRepurpose = usePluginAction(ACTION_KEYS.queueContentRepurpose);
  const generateContentCampaign = usePluginAction(ACTION_KEYS.generateContentCampaign);
  const launchMissionControl = usePluginAction(ACTION_KEYS.launchMissionControl);
  const runPipelineWatchdog = usePluginAction(ACTION_KEYS.runPipelineWatchdog);
  const generateDailyBrief = usePluginAction(ACTION_KEYS.generateDailyBrief);

  const [message, setMessage] = useState<string>("");
  const [lastResult, setLastResult] = useState<unknown>(null);

  const [meetingProjectId, setMeetingProjectId] = useState("");
  const [meetingTitle, setMeetingTitle] = useState("Weekly Sync");
  const [meetingTranscript, setMeetingTranscript] = useState("Action items:\n- Alice to send proposal by Friday\n- Bob to schedule follow-up demo");

  const [proposalTitle, setProposalTitle] = useState("Discovery Proposal");
  const [proposalNotes, setProposalNotes] = useState("The client wants a concise proposal covering deliverables, timeline, and next steps.");

  const [emailProjectId, setEmailProjectId] = useState("");
  const [emailSubject, setEmailSubject] = useState("Re: CRM automation scope");
  const [emailFromName, setEmailFromName] = useState("Morgan");
  const [emailFromEmail, setEmailFromEmail] = useState("morgan@example.com");
  const [emailDesiredOutcome, setEmailDesiredOutcome] = useState("confirm the next working session and outline the proposal path");
  const [emailThread, setEmailThread] = useState("Thanks for the ideas. Can you send a tighter proposal and confirm next steps by Thursday?");

  const [calendarProjectId, setCalendarProjectId] = useState("");
  const [calendarTitle, setCalendarTitle] = useState("Pipeline review");
  const [calendarStartsAt, setCalendarStartsAt] = useState("2026-05-08T10:00:00.000Z");
  const [calendarAttendees, setCalendarAttendees] = useState("alex@example.com, jamie@example.com");
  const [calendarNotes, setCalendarNotes] = useState("Action items:\n- Review top stalled deals\n- Prepare renewal summary for Friday");

  const [leadProjectId, setLeadProjectId] = useState("");
  const [leadName, setLeadName] = useState("Jane Smith");
  const [leadOrg, setLeadOrg] = useState("Acme Inc.");
  const [leadNeed, setLeadNeed] = useState("Help automating inbound sales follow-up");
  const [leadNotes, setLeadNotes] = useState("Interested in CRM automation and daily reporting.");
  const [leadStage, setLeadStage] = useState<(typeof LEAD_STAGES)[number]>("qualified");
  const [leadNextStep, setLeadNextStep] = useState("Send the scoped automation proposal");
  const [leadNextFollowUp, setLeadNextFollowUp] = useState("2026-05-09");
  const [leadPipelineNotes, setLeadPipelineNotes] = useState("Strong intent, wants a clear timeline and implementation owner.");

  const [contentProjectId, setContentProjectId] = useState("");
  const [sourceTitle, setSourceTitle] = useState("Founder interview clip");
  const [sourceSummary, setSourceSummary] = useState("Turn the core story into social snippets and a newsletter angle.");
  const [platforms, setPlatforms] = useState("x, linkedin, newsletter");

  const [campaignProjectId, setCampaignProjectId] = useState("");
  const [campaignName, setCampaignName] = useState("Q2 demand sprint");
  const [campaignAngle, setCampaignAngle] = useState("Show how fast operator workflows can go from transcript to revenue follow-up.");
  const [campaignCta, setCampaignCta] = useState("Reply for the workflow pack.");
  const [campaignPlatforms, setCampaignPlatforms] = useState("x, linkedin, newsletter");

  const [focusDate, setFocusDate] = useState("2026-05-08");
  const [focusHours, setFocusHours] = useState("4");
  const [focusStart, setFocusStart] = useState("09:00");

  const [missionProjectId, setMissionProjectId] = useState("");
  const [missionObjective, setMissionObjective] = useState("Ship the next workflow launch week");
  const [missionLanes, setMissionLanes] = useState("Revenue, Content, Operations, Product");
  const [invokeAgents, setInvokeAgents] = useState(false);

  async function runAction(label: string, task: () => Promise<unknown>) {
    try {
      setMessage(`${label} in progress…`);
      const result = await task();
      setLastResult(result);
      setMessage(`${label} complete.`);
      setRefreshKey((value) => value + 1);
      return result;
    } catch (actionError) {
      setMessage(`${label} failed: ${actionError instanceof Error ? actionError.message : String(actionError)}`);
      setLastResult(null);
      return null;
    }
  }

  if (!companyId) {
    return <section style={card}>Business Workflows requires a company context.</section>;
  }

  if (loading && !data) {
    return <section style={card}>Loading Business Workflows…</section>;
  }

  if (error) {
    return <section style={card}>Business Workflows error: {error.message}</section>;
  }

  return (
    <section style={stack}>
      <section style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: 4 }}>
            <strong>Business Workflows</strong>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              High-value operator automation for meetings, email, CRM, focus planning, mission control, and campaign ops.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={button} onClick={() => void runAction("Daily brief", () => generateDailyBrief({ companyId }))}>Generate daily brief</button>
            <button style={button} onClick={() => void runAction("Watchdog", () => runPipelineWatchdog({ companyId }))}>Run watchdog</button>
          </div>
        </div>
        {message ? <div style={{ marginTop: 10, fontSize: 12 }}>{message}</div> : null}
      </section>

      <section style={grid}>
        <section style={card}>
          <strong>Meeting transcript → tasks</strong>
          <div style={stack}>
            <Label title="Project"><ProjectSelect value={meetingProjectId} onChange={setMeetingProjectId} projects={projects} /></Label>
            <Label title="Meeting title"><input style={input} value={meetingTitle} onChange={(event) => setMeetingTitle(event.target.value)} placeholder="Meeting title" /></Label>
            <Label title="Transcript"><textarea style={textarea} value={meetingTranscript} onChange={(event) => setMeetingTranscript(event.target.value)} /></Label>
            <button
              style={primaryButton}
              onClick={() => void runAction("Meeting ingest", () => ingestMeetingTranscript({ companyId, projectId: meetingProjectId, title: meetingTitle, transcript: meetingTranscript }))}
            >
              Ingest meeting transcript
            </button>
          </div>
        </section>

        <section style={card}>
          <strong>Proposal draft</strong>
          <div style={stack}>
            <Label title="Proposal title"><input style={input} value={proposalTitle} onChange={(event) => setProposalTitle(event.target.value)} placeholder="Proposal title" /></Label>
            <Label title="Notes"><textarea style={textarea} value={proposalNotes} onChange={(event) => setProposalNotes(event.target.value)} /></Label>
            <button
              style={primaryButton}
              onClick={() => void runAction("Proposal draft", () => generateProposalDraft({ companyId, title: proposalTitle, notes: proposalNotes }))}
            >
              Generate proposal draft
            </button>
          </div>
        </section>

        <section style={card}>
          <strong>Email triage + reply</strong>
          <div style={stack}>
            <Label title="Project"><ProjectSelect value={emailProjectId} onChange={setEmailProjectId} projects={projects} /></Label>
            <Label title="Subject"><input style={input} value={emailSubject} onChange={(event) => setEmailSubject(event.target.value)} placeholder="Email subject" /></Label>
            <Label title="Sender name"><input style={input} value={emailFromName} onChange={(event) => setEmailFromName(event.target.value)} placeholder="Sender name" /></Label>
            <Label title="Sender email"><input style={input} value={emailFromEmail} onChange={(event) => setEmailFromEmail(event.target.value)} placeholder="Sender email" /></Label>
            <Label title="Desired outcome"><input style={input} value={emailDesiredOutcome} onChange={(event) => setEmailDesiredOutcome(event.target.value)} placeholder="Desired reply outcome" /></Label>
            <Label title="Thread"><textarea style={textarea} value={emailThread} onChange={(event) => setEmailThread(event.target.value)} /></Label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                style={primaryButton}
                onClick={() => void runAction("Email triage", () => ingestEmailThread({ companyId, projectId: emailProjectId, subject: emailSubject, fromName: emailFromName, fromEmail: emailFromEmail, desiredOutcome: emailDesiredOutcome, thread: emailThread }))}
              >
                Ingest thread + draft reply
              </button>
              <button
                style={subtleButton}
                onClick={() => void runAction("Reply draft", () => generateEmailReply({ companyId, subject: emailSubject, senderName: emailFromName, desiredOutcome: emailDesiredOutcome, thread: emailThread }))}
              >
                Draft reply only
              </button>
            </div>
          </div>
        </section>

        <section style={card}>
          <strong>Calendar follow-up</strong>
          <div style={stack}>
            <Label title="Project"><ProjectSelect value={calendarProjectId} onChange={setCalendarProjectId} projects={projects} /></Label>
            <Label title="Event title"><input style={input} value={calendarTitle} onChange={(event) => setCalendarTitle(event.target.value)} placeholder="Event title" /></Label>
            <Label title="Starts at"><input style={input} value={calendarStartsAt} onChange={(event) => setCalendarStartsAt(event.target.value)} placeholder="2026-05-08T10:00:00.000Z" /></Label>
            <Label title="Attendees"><input style={input} value={calendarAttendees} onChange={(event) => setCalendarAttendees(event.target.value)} placeholder="name@example.com, teammate@example.com" /></Label>
            <Label title="Notes"><textarea style={textarea} value={calendarNotes} onChange={(event) => setCalendarNotes(event.target.value)} /></Label>
            <button
              style={primaryButton}
              onClick={() => void runAction("Calendar event", () => ingestCalendarEvent({ companyId, projectId: calendarProjectId, title: calendarTitle, startsAt: calendarStartsAt, attendees: splitCsv(calendarAttendees), notes: calendarNotes }))}
            >
              Ingest calendar event
            </button>
          </div>
        </section>

        <section style={card}>
          <strong>Lead intake</strong>
          <div style={stack}>
            <Label title="Project"><ProjectSelect value={leadProjectId} onChange={setLeadProjectId} projects={projects} /></Label>
            <Label title="Lead name"><input style={input} value={leadName} onChange={(event) => setLeadName(event.target.value)} placeholder="Lead name" /></Label>
            <Label title="Organization"><input style={input} value={leadOrg} onChange={(event) => setLeadOrg(event.target.value)} placeholder="Organization" /></Label>
            <Label title="Need"><input style={input} value={leadNeed} onChange={(event) => setLeadNeed(event.target.value)} placeholder="Need" /></Label>
            <Label title="Notes"><textarea style={textarea} value={leadNotes} onChange={(event) => setLeadNotes(event.target.value)} /></Label>
            <button
              style={primaryButton}
              onClick={() => void runAction("Lead intake", () => ingestLead({ companyId, projectId: leadProjectId, leadName, organization: leadOrg, need: leadNeed, notes: leadNotes, source: "ui" }))}
            >
              Create lead issue
            </button>
          </div>
        </section>

        <section style={card}>
          <strong>Lead pipeline update</strong>
          <div style={stack}>
            <Label title="Lead name"><input style={input} value={leadName} onChange={(event) => setLeadName(event.target.value)} placeholder="Lead name" /></Label>
            <Label title="Stage">
              <select style={input} value={leadStage} onChange={(event) => setLeadStage(event.target.value as (typeof LEAD_STAGES)[number])}>
                {LEAD_STAGES.map((stage) => (
                  <option key={stage} value={stage}>{stage}</option>
                ))}
              </select>
            </Label>
            <Label title="Next step"><input style={input} value={leadNextStep} onChange={(event) => setLeadNextStep(event.target.value)} placeholder="Next step" /></Label>
            <Label title="Next follow-up"><input style={input} value={leadNextFollowUp} onChange={(event) => setLeadNextFollowUp(event.target.value)} placeholder="YYYY-MM-DD" /></Label>
            <Label title="Pipeline notes"><textarea style={textarea} value={leadPipelineNotes} onChange={(event) => setLeadPipelineNotes(event.target.value)} /></Label>
            <button
              style={primaryButton}
              onClick={() => void runAction("Lead pipeline update", () => updateLeadPipeline({ companyId, projectId: leadProjectId, leadName, organization: leadOrg, stage: leadStage, nextStep: leadNextStep, nextFollowUp: leadNextFollowUp, notes: leadPipelineNotes, source: "ui" }))}
            >
              Update lead pipeline
            </button>
          </div>
        </section>

        <section style={card}>
          <strong>Content repurposing</strong>
          <div style={stack}>
            <Label title="Project"><ProjectSelect value={contentProjectId} onChange={setContentProjectId} projects={projects} /></Label>
            <Label title="Source title"><input style={input} value={sourceTitle} onChange={(event) => setSourceTitle(event.target.value)} placeholder="Source title" /></Label>
            <Label title="Source summary"><textarea style={textarea} value={sourceSummary} onChange={(event) => setSourceSummary(event.target.value)} /></Label>
            <Label title="Platforms"><input style={input} value={platforms} onChange={(event) => setPlatforms(event.target.value)} placeholder="x, linkedin, newsletter" /></Label>
            <button
              style={primaryButton}
              onClick={() => void runAction("Content repurpose", () => queueContentRepurpose({ companyId, projectId: contentProjectId, sourceTitle, sourceSummary, platforms: splitCsv(platforms) }))}
            >
              Queue repurposing tasks
            </button>
          </div>
        </section>

        <section style={card}>
          <strong>Content campaign pack</strong>
          <div style={stack}>
            <Label title="Project"><ProjectSelect value={campaignProjectId} onChange={setCampaignProjectId} projects={projects} /></Label>
            <Label title="Campaign name"><input style={input} value={campaignName} onChange={(event) => setCampaignName(event.target.value)} placeholder="Campaign name" /></Label>
            <Label title="Campaign angle"><input style={input} value={campaignAngle} onChange={(event) => setCampaignAngle(event.target.value)} placeholder="Campaign angle" /></Label>
            <Label title="Call to action"><input style={input} value={campaignCta} onChange={(event) => setCampaignCta(event.target.value)} placeholder="Call to action" /></Label>
            <Label title="Platforms"><input style={input} value={campaignPlatforms} onChange={(event) => setCampaignPlatforms(event.target.value)} placeholder="x, linkedin, newsletter" /></Label>
            <button
              style={primaryButton}
              onClick={() => void runAction("Content campaign", () => generateContentCampaign({ companyId, projectId: campaignProjectId, campaignName, sourceTitle, sourceSummary, angle: campaignAngle, callToAction: campaignCta, platforms: splitCsv(campaignPlatforms) }))}
            >
              Generate campaign pack
            </button>
          </div>
        </section>

        <section style={card}>
          <strong>Focus planning</strong>
          <div style={stack}>
            <Label title="Date"><input style={input} value={focusDate} onChange={(event) => setFocusDate(event.target.value)} placeholder="YYYY-MM-DD" /></Label>
            <Label title="Preferred start"><input style={input} value={focusStart} onChange={(event) => setFocusStart(event.target.value)} placeholder="09:00" /></Label>
            <Label title="Hours"><input style={input} value={focusHours} onChange={(event) => setFocusHours(event.target.value)} placeholder="4" /></Label>
            <button
              style={primaryButton}
              onClick={() => void runAction("Focus plan", () => planFocusBlocks({ companyId, date: focusDate, preferredStart: focusStart, hours: Number(focusHours) || 4 }))}
            >
              Plan focus blocks
            </button>
          </div>
        </section>

        <section style={card}>
          <strong>Mission control</strong>
          <div style={stack}>
            <Label title="Project"><ProjectSelect value={missionProjectId} onChange={setMissionProjectId} projects={projects} /></Label>
            <Label title="Objective"><input style={input} value={missionObjective} onChange={(event) => setMissionObjective(event.target.value)} placeholder="Objective" /></Label>
            <Label title="Lanes"><input style={input} value={missionLanes} onChange={(event) => setMissionLanes(event.target.value)} placeholder="Revenue, Content, Operations, Product" /></Label>
            <label style={checkboxRow}>
              <input type="checkbox" checked={invokeAgents} onChange={(event) => setInvokeAgents(event.target.checked)} />
              Invoke available agents when launching mission control
            </label>
            <button
              style={primaryButton}
              onClick={() => void runAction("Mission control", () => launchMissionControl({ companyId, projectId: missionProjectId, objective: missionObjective, lanes: splitCsv(missionLanes), invokeAgents }))}
            >
              Launch mission control
            </button>
          </div>
        </section>
      </section>

      <section style={artifactGrid}>
        <ArtifactCard title="Latest daily brief" artifact={data?.latestDailyBrief ?? null} emptyMessage="No brief available yet." />
        <ArtifactCard title="Latest proposal draft" artifact={data?.latestProposalDraft ?? null} subtitle={data?.latestProposalDraft?.title} emptyMessage="No proposal generated yet." />
        <ArtifactCard title="Latest email reply" artifact={data?.latestEmailReply ?? null} subtitle={data?.latestEmailReply?.subject} emptyMessage="No email reply generated yet." />
        <ArtifactCard title="Latest focus plan" artifact={data?.latestFocusPlan ?? null} subtitle={data?.latestFocusPlan?.date} emptyMessage="No focus plan generated yet." />
        <ArtifactCard title="Latest content campaign" artifact={data?.latestContentCampaign ?? null} subtitle={data?.latestContentCampaign?.title} emptyMessage="No campaign pack generated yet." />
        <ArtifactCard title="Latest mission control" artifact={data?.latestMissionControlPlan ?? null} subtitle={data?.latestMissionControlPlan?.objective} emptyMessage="No mission control plan generated yet." />
        <ArtifactCard title="Latest watchdog report" artifact={data?.latestWatchdogReport ?? null} emptyMessage="No watchdog report generated yet." />
      </section>

      <section style={grid}>
        <section style={card}>
          <strong>Overview counts</strong>
          <JsonLike value={data?.counts ?? {}} />
        </section>
        <section style={card}>
          <strong>Agents</strong>
          <JsonLike value={data?.agents ?? []} />
        </section>
        <section style={card}>
          <strong>Lead pipeline</strong>
          <JsonLike value={data?.leadPipeline ?? []} />
        </section>
      </section>

      <section style={grid}>
        <section style={card}>
          <strong>Open issues</strong>
          <JsonLike value={data?.openIssues ?? []} />
        </section>
        <section style={card}>
          <strong>Active goals</strong>
          <JsonLike value={data?.activeGoals ?? []} />
        </section>
        <section style={card}>
          <strong>Last action result</strong>
          <JsonLike value={lastResult ?? { status: "No action result yet." }} />
        </section>
      </section>

      <section style={card}>
        <strong>Recent workflow records</strong>
        <JsonLike value={data?.recentRecords ?? []} />
      </section>
    </section>
  );
}