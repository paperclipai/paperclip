import { RoutineTriggerCard } from "../fixtures/routineTriggerCard";
import { RoutineTriggerWizard, defaultTriggerDraft, type TriggerDraft } from "../fixtures/routineTriggerWizard";
import { CopyField } from "../fixtures/routineWebhookFields";
import { useCallback, useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { AlertCircle, ArrowRight, CalendarClock, Check, CheckCircle2, ChevronRight, Copy, GitBranch, Globe, KeyRound, Play, Radio, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RoutineDetail } from "@/pages/RoutineDetail";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link, useNavigate, useParams } from "@/lib/router";
import { cn } from "@/lib/utils";
import { WebhookReview } from "../fixtures/routineWebhooks";

// Deliberately Storybook-only: no production components or webhook APIs are changed.
const endpoint = "https://acme.paperclip.example/api/routine-triggers/public/0123456789abcdef01234567/fire";
const secret = "demo_webhook_key_for_storybook_only";
const root = "/routines/routine-webhook-story";
type Stage = "setup" | "credentials" | "waiting" | "received" | "failure";
type Sender = "custom" | "github";
type TriggerKind = "choose" | "schedule" | "webhook";
type CheckResult = "waiting" | "received" | "rejected" | "no_event";
type Props = {
  stage: Stage;
  sender: Sender;
  page: "triggers" | "overview" | "activity";
  triggerKind: TriggerKind;
  wizardStep: number;
  expandedWebhook?: boolean;
  scheduleSaved: boolean;
  checkResult: CheckResult;
};

function HumanActivity({ received, sample }: { received: boolean; sample: boolean }) {
  const events = [
    ...(received ? [{ time: "Just now", title: sample ? "Test event received" : "Webhook received", summary: sample ? "Connection check passed" : "Created PAP-123", details: { event: "deployment.completed", environment: "production", authentication: "Passed", ...(sample ? { test: true, taskCreated: false } : { task: "PAP-123" }) } }] : []),
    { time: "10:04 AM", title: "Webhook rejected", summary: "Invalid secret", details: { reason: "The sender's key did not match this webhook.", taskCreated: false } },
    { time: "9:42 AM", title: "Instructions updated", summary: "Riley Board", details: { changed: "Deployment health checks" } },
    { time: "9:40 AM", title: "Webhook created", summary: "Deployment completed", details: { sender: "Another app or script", authentication: "Secret key" } },
  ];
  return <div className="space-y-3"><p className="text-xs text-muted-foreground">Today</p>{events.map((event) => <details key={event.title} className="group border-b border-border pb-2">
    <summary className="flex cursor-pointer list-none items-center gap-3 rounded-md py-2 text-xs hover:bg-accent/50">
      <span className="w-16 shrink-0 whitespace-nowrap font-mono text-muted-foreground">{event.time}</span>
      <span className="shrink-0 font-medium">{event.title}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={event.summary}>{event.summary}</span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-open:rotate-90" />
    </summary>
    <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(event.details, null, 2)}</pre>
  </details>)}</div>;
}

function WebhookPrototypePage({ stage: initialStage, sender: initialSender, triggerKind: initialKind, scheduleSaved: initialScheduleSaved, checkResult, wizardStep, expandedWebhook = false }: Props) {
  const { section = "triggers" } = useParams<{ section?: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const draftKey = `storybook:routine-trigger-draft:v2:${window.location.search}`;
  const [savedDraft, setSavedDraft] = useState<TriggerDraft | null>(() => {
    try { const stored = sessionStorage.getItem(draftKey); return stored ? JSON.parse(stored) as TriggerDraft : null; } catch { return null; }
  });
  const [wizardDraft, setWizardDraft] = useState<TriggerDraft>({ ...defaultTriggerDraft, kind: initialKind, sender: initialSender, step: wizardStep, availableStep: wizardStep, created: wizardStep >= 1 && initialKind === "webhook" });
  const [stage, setStage] = useState(initialStage);
  const [scheduleSaved, setScheduleSaved] = useState(initialScheduleSaved);
  const [editingTrigger, setEditingTrigger] = useState<"schedule" | "webhook" | null>(expandedWebhook ? "webhook" : null);
  const [scheduleRemoved, setScheduleRemoved] = useState(false);
  const [webhookRemoved, setWebhookRemoved] = useState(false);
  const [scheduleEdit, setScheduleEdit] = useState({ frequency: "weekdays", time: "09:00", weekday: "Monday", timezone: "America/Chicago" });
  // Step stories always open at their requested step, even after saving a preview draft.
  const [adding, setAdding] = useState(initialStage === "setup" && !initialScheduleSaved);
  const [frequency, setFrequency] = useState("weekdays");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState("Monday");
  const [timezone, setTimezone] = useState("America/Chicago");
  const [checkState, setCheckState] = useState(checkResult);
  useEffect(() => { setCheckState(checkResult); }, [checkResult]);
  const [sender, setSender] = useState(initialSender);
  const [active, setActive] = useState(true);
  const [keyVisible, setKeyVisible] = useState(initialStage === "credentials");
  const [mode, setMode] = useState("bearer");
  const [dialog, setDialog] = useState<"connection" | "routine" | "rotate" | null>(null);
  const sample = false;
  const [tested, setTested] = useState(false);
  const [payload, setPayload] = useState('{\n  "event": "deployment.completed",\n  "environment": "production"\n}');
  const [payloadError, setPayloadError] = useState("");
  const saveAndExit = useCallback((draft: TriggerDraft) => {
    sessionStorage.setItem(draftKey, JSON.stringify(draft));
    setSavedDraft(draft);
    setWizardDraft(draft);
    setAdding(false);
  }, [draftKey]);
  useEffect(() => {
    const webhookCard = <RoutineTriggerCard kind="webhook" icon={<Webhook className="h-4 w-4" />} title={github ? "GitHub webhook" : "Webhook"} summary={`${github ? "GitHub" : "Another app or script"} · ${status}`} expanded={editingTrigger === "webhook"} onEdit={() => setEditingTrigger(editingTrigger === "webhook" ? null : "webhook")} onRemove={() => { setWebhookRemoved(true); setEditingTrigger(null); }}>
    {connection}
    <div className="flex justify-end"><Button variant="outline" onClick={() => setEditingTrigger(null)}>Done</Button></div>
  </RoutineTriggerCard>;
  if (adding && section === "triggers") return;
    if (!["triggers", "overview", "activity"].includes(section)) return;
    setBreadcrumbs([
      { label: "Verify a deployment", href: `${root}/overview` },
      { label: section === "activity" ? "Activity" : section === "overview" ? "Overview" : "Triggers" },
    ]);
  }, [adding, section, setBreadcrumbs]);
  if (!["triggers", "overview", "activity"].includes(section)) return <RoutineDetail />;
  const created = stage !== "setup" && !webhookRemoved;
  const received = stage === "received";
  const failed = stage === "failure";
  const github = sender === "github";
  const authenticated = github || mode !== "none";
  const status = !active ? "Paused" : failed ? "Needs attention" : received ? (sample ? "Test event received" : "Receiving events") : "Waiting for first event";
  const validatePayload = () => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
      setPayloadError(""); return true;
    } catch { setPayloadError("Enter a valid JSON object, for example {\"event\": \"deployment.completed\"}."); return false; }
  };
  const showConnection = () => { setCheckState(checkResult); setDialog("connection"); };
  const scheduleSummary = `${frequency === "daily" ? "Every day" : frequency === "weekly" ? `Every ${weekday}` : "Every weekday"} at ${time}`;
  const editSchedule = () => {
    setScheduleEdit({ frequency, time, weekday, timezone });
    setEditingTrigger(editingTrigger === "schedule" ? null : "schedule");
  };
  const selectClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  const scheduleCard = <RoutineTriggerCard kind="schedule" icon={<CalendarClock className="h-4 w-4" />} title={scheduleSummary} summary={`${timezone} · ${active ? "Runs automatically on this schedule" : "Paused"}`} expanded={editingTrigger === "schedule"} onEdit={editSchedule} onRemove={() => { setScheduleSaved(false); setScheduleRemoved(true); setEditingTrigger(null); }}>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2"><Label htmlFor="edit-repeat">Repeat</Label><select id="edit-repeat" className={selectClass} value={scheduleEdit.frequency} onChange={(event) => setScheduleEdit({ ...scheduleEdit, frequency: event.target.value })}><option value="daily">Every day</option><option value="weekdays">Weekdays (Monday–Friday)</option><option value="weekly">Every week</option></select></div>
      <div className="space-y-2"><Label htmlFor="edit-time">Time</Label><Input id="edit-time" type="time" value={scheduleEdit.time} onChange={(event) => setScheduleEdit({ ...scheduleEdit, time: event.target.value })} /></div>
      {scheduleEdit.frequency === "weekly" && <div className="space-y-2"><Label htmlFor="edit-day">Day</Label><select id="edit-day" className={selectClass} value={scheduleEdit.weekday} onChange={(event) => setScheduleEdit({ ...scheduleEdit, weekday: event.target.value })}>{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => <option key={day}>{day}</option>)}</select></div>}
      <div className="space-y-2"><Label htmlFor="edit-zone">Time zone</Label><select id="edit-zone" className={selectClass} value={scheduleEdit.timezone} onChange={(event) => setScheduleEdit({ ...scheduleEdit, timezone: event.target.value })}>{["America/Chicago", "America/New_York", "America/Los_Angeles", "Europe/London", "UTC"].map((zone) => <option key={zone}>{zone}</option>)}</select></div>
    </div>
    <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setEditingTrigger(null)}>Cancel</Button><Button disabled={!scheduleEdit.time} onClick={() => { setFrequency(scheduleEdit.frequency); setTime(scheduleEdit.time); setWeekday(scheduleEdit.weekday); setTimezone(scheduleEdit.timezone); setEditingTrigger(null); }}>Save schedule</Button></div>
  </RoutineTriggerCard>;
  const connectionStatus = <div className={cn("flex items-start gap-3 rounded-md bg-muted/40 p-4", failed && "bg-destructive/5")} role="status">
    {failed ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> : received ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-(--status-task-done)" /> : <Radio className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
    <div className="min-w-0 flex-1 space-y-1">
      <p className="text-sm font-medium">{status}</p>
      <p className="text-xs text-muted-foreground">{!active ? "Automatic runs are paused. Resume when you’re ready to receive events." : failed ? "The last request had an invalid secret. Update the key in your sending app, then try again." : received ? (sample ? "Webhook intake passed. Send an event from your app to finish checking the connection." : "Last event 2 minutes ago · Deployment completed") : "This webhook is enabled. New events from your app will start the routine."}</p>
      {received && !sample && <Link className="inline-flex items-center gap-1 text-xs underline underline-offset-4" to={`${root}/runs`}>Created PAP-123 · View task in runs <ArrowRight className="h-3 w-3" /></Link>}
    </div>
  </div>;
  const connection = <div className="space-y-5">
    {connectionStatus}
    <div className="space-y-4"><div className="space-y-1"><h3 className="text-sm font-medium">Connect {github ? "GitHub" : "your app"}</h3><p className="text-xs text-muted-foreground">{github ? "In your repository, open Settings → Webhooks → Add webhook." : "Open your app’s webhook settings and paste these connection details."}</p></div>
      <CopyField label={github ? "Payload URL" : "Webhook URL"} value={endpoint} help={github ? "Set Content type to application/json and choose the events to send." : "Send a POST request with a JSON body to this URL."} />
      {authenticated && (keyVisible ? <div className="space-y-4 rounded-md border border-border p-4"><div className="flex items-start gap-2"><KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><div><p className="text-sm font-medium">Save your key before leaving</p><p className="text-xs text-muted-foreground">This key is only shown once. Paste it into {github ? "GitHub’s Secret field" : "your app’s authentication settings"}.</p></div></div>
        {github || mode === "hmac" ? <CopyField label="Secret" value={secret} /> : <><CopyField label="Authorization header value" value={`Bearer ${secret}`} help="Header name: Authorization. The value above already includes “Bearer”." /><details><summary className="cursor-pointer text-xs text-muted-foreground">My app asks for the key only</summary><div className="pt-3"><CopyField label="Secret key" value={secret} /></div></details></>}
        <Button variant="outline" size="sm" onClick={() => { setKeyVisible(false); if (stage === "credentials") setStage("waiting"); }}><Check className="h-3.5 w-3.5" />I’ve saved the key</Button>
      </div> : <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"><div className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-muted-foreground" /><div><p className="text-sm">{github ? "GitHub signature verification" : mode === "hmac" ? "Signed requests" : "Secret key authentication"}</p><p className="text-xs text-muted-foreground">The key is hidden after setup.</p></div></div><Button variant="ghost" size="sm" onClick={() => setDialog("rotate")}>Replace key</Button></div>)}
      {!authenticated && <p className="text-xs text-muted-foreground">No authentication · Anyone with this URL can start the routine.</p>}
      <div className="flex flex-wrap items-center gap-3"><Button variant="outline" size="sm" disabled={!active} onClick={showConnection}><Radio className="h-3.5 w-3.5" />Check connection</Button><span className="text-xs text-muted-foreground">Watch for an event sent from your app.</span></div>
      {github && <p className="text-xs text-muted-foreground">After saving in GitHub, use Redeliver on a recent delivery to check the full connection.</p>}
      {!github && mode === "hmac" && <details><summary className="cursor-pointer text-xs text-muted-foreground">Signing instructions</summary><p className="pt-2 text-xs text-muted-foreground">Sign the timestamp and raw request body using HMAC-SHA256. This prototype is reviewing the setup flow; exact sender code will accompany implementation.</p></details>}
    </div>
  </div>;
  const webhookCard = <RoutineTriggerCard kind="webhook" icon={<Webhook className="h-4 w-4" />} title={github ? "GitHub webhook" : "Webhook"} summary={`${github ? "GitHub" : "Another app or script"} · ${status}`} expanded={editingTrigger === "webhook"} onEdit={() => setEditingTrigger(editingTrigger === "webhook" ? null : "webhook")} onRemove={() => { setWebhookRemoved(true); setEditingTrigger(null); }}>
    {connection}
    <div className="flex justify-end"><Button variant="outline" onClick={() => setEditingTrigger(null)}>Done</Button></div>
  </RoutineTriggerCard>;
  if (adding && section === "triggers") return <RoutineTriggerWizard initialDraft={wizardDraft} checkResult={checkResult}
    onSaveExit={saveAndExit}
    onFinish={(draft) => { sessionStorage.removeItem(draftKey); setSavedDraft(null); setAdding(false); if (draft.kind === "schedule") { setFrequency(draft.frequency); setTime(draft.time); setTimezone(draft.timezone); setWeekday(draft.weekday); setScheduleSaved(true); setScheduleRemoved(false); } else { setSender(draft.sender); setStage("waiting"); setKeyVisible(false); setWebhookRemoved(false); } }} />;
  return <div className="-m-4 flex h-full min-h-0 flex-col overflow-hidden md:-m-6">
    <header className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-4"><h1 className="min-w-0 flex-1 text-xl font-bold">Verify a deployment</h1><Button variant="outline" size="sm" onClick={() => { setTested(false); setDialog("routine"); }}><Play className="h-3.5 w-3.5" />Test routine</Button><div className="flex items-center gap-2"><ToggleSwitch checked={active} onCheckedChange={setActive} aria-label="Automatic triggers" /><span className="text-sm text-muted-foreground">{active ? "Active" : "Paused"}</span></div></header>
    <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8"><div className="mx-auto max-w-3xl space-y-5"><h2 className="text-lg font-semibold">{section === "activity" ? "Activity" : section === "overview" ? "Overview" : "Triggers"}</h2>
      {section === "triggers" ? <div className="space-y-6">
        {scheduleSaved && scheduleCard}
        {created && webhookCard}
        {scheduleRemoved && <div role="status" className="flex items-center justify-between gap-3 text-sm"><span className="text-muted-foreground">Schedule removed.</span><Button variant="ghost" size="sm" onClick={() => { setScheduleSaved(true); setScheduleRemoved(false); }}>Undo remove schedule</Button></div>}
        {webhookRemoved && <div role="status" className="flex items-center justify-between gap-3 text-sm"><span className="text-muted-foreground">Webhook removed.</span><Button variant="ghost" size="sm" onClick={() => setWebhookRemoved(false)}>Undo remove webhook</Button></div>}
        {savedDraft && <div className="flex items-center justify-between gap-3 rounded-md border border-border p-4"><div><p className="text-sm font-medium">Trigger setup saved</p><p className="text-xs text-muted-foreground">Pick up where you left off.</p></div><Button onClick={() => { setWizardDraft(savedDraft); setAdding(true); }}>Resume setup</Button></div>}
        <Button variant="outline" size="sm" onClick={() => { setWizardDraft({ ...defaultTriggerDraft }); setAdding(true); }}>{created || scheduleSaved ? "Add another trigger" : "Add trigger"}</Button>
      </div> : section === "activity" ? <HumanActivity received={received} sample={sample} /> : <div className="space-y-6"><div className="space-y-2"><h3 className="text-sm font-medium">What this routine does</h3><p className="text-sm text-muted-foreground">Check the deployment from the incoming webhook. Verify the service is healthy and report the result.</p></div><div className="space-y-3"><div className="flex items-center justify-between"><h3 className="text-sm font-medium">When it runs</h3><Link className="text-xs underline underline-offset-4" to={`${root}/triggers`}>{created || scheduleSaved ? "Manage triggers" : "Add a trigger"}</Link></div>{scheduleSaved && scheduleCard}{created && <><p className="flex items-center gap-2 text-sm"><Webhook className="h-4 w-4 text-muted-foreground" />When another app sends a webhook</p>{connectionStatus}</>}{!created && !scheduleSaved && <p className="text-xs text-muted-foreground">Choose a schedule or webhook to start this routine automatically.</p>}</div><div className="space-y-3"><div className="flex justify-between"><h3 className="text-sm font-medium">Recent runs</h3><Link className="text-xs underline underline-offset-4" to={`${root}/runs`}>View all runs</Link></div>{received && !sample ? <Link to={`${root}/runs`} className="flex items-center gap-3 text-sm"><CheckCircle2 className="h-4 w-4 text-(--status-task-done)" /><span className="font-mono text-xs text-muted-foreground">PAP-123</span>Verify the production deployment</Link> : <p className="text-sm text-muted-foreground">No runs yet. Test the routine or send an event from your app.</p>}</div></div>}
    </div></main>
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null); }}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>{dialog === "rotate" ? "Replace webhook key?" : dialog === "routine" ? "Test this routine" : "Check webhook connection"}</DialogTitle><DialogDescription>{dialog === "rotate" ? "The old key will stop working immediately. Update your sending app with the new key." : dialog === "routine" ? "Run the routine with sample data. This creates a task and lets the agent do real work." : "Send an event from your other app. Paperclip will show you whether it arrived and passed authentication."}</DialogDescription></DialogHeader>
      {dialog === "connection" ? <div className="space-y-4">
        <ol className="list-decimal space-y-3 pl-5 text-sm"><li><span className="font-medium">Save the connection in {github ? "GitHub" : "your app"}.</span><p className="text-xs text-muted-foreground">Use this webhook URL{authenticated ? " and the key you copied during setup" : ""}.</p></li><li><span className="font-medium">{github ? "Send a delivery from GitHub." : "Send a test event from that app."}</span><p className="text-xs text-muted-foreground">{github ? "Open repository Settings → Webhooks → this webhook → Recent Deliveries, then choose Redeliver." : "Look for “Send test” in its webhook settings. If there isn’t one, perform the action that should trigger the webhook, such as completing a deployment."}</p></li><li><span className="font-medium">Keep this window open to see the result.</span><p className="text-xs text-muted-foreground">Only events arriving after you open this check are shown here.</p></li></ol>
        <CopyField label="Webhook URL" value={endpoint} />
        <p className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">This observes normal deliveries. An accepted event can start the routine and create a task, just like any other webhook.</p>
        <div role="status" className="flex items-start gap-3 rounded-md border border-border p-4">{checkState === "received" ? <CheckCircle2 className="h-5 w-5 shrink-0 text-(--status-task-done)" /> : checkState === "rejected" ? <AlertCircle className="h-5 w-5 shrink-0 text-destructive" /> : <Radio className="h-5 w-5 shrink-0 text-muted-foreground" />}<div className="min-w-0 space-y-1"><p className="text-sm font-medium">{checkState === "received" ? "Event received · Connection working" : checkState === "rejected" ? "Event arrived, but the key was rejected" : checkState === "no_event" ? "No event received yet" : "Waiting for an event from your app…"}</p><p className="text-xs text-muted-foreground">{checkState === "received" ? "Authentication passed · Created task PAP-123" : checkState === "rejected" ? "Update the secret in your sending app and resend. No task was created." : checkState === "no_event" ? "Check that you saved the exact URL, enabled the webhook in your app, and sent an event. For custom scripts, use POST with a JSON body." : "Nothing to send from Paperclip. Send the event from your app, then return here."}</p></div></div>
        {checkState === "received" && <details><summary className="cursor-pointer text-xs text-muted-foreground">View received event</summary><pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{payload}</pre></details>}
        <DialogFooter><Button variant="ghost" onClick={() => setDialog(null)}>{checkState === "received" ? "Done" : "Stop checking"}</Button>{checkState === "received" ? <Button onClick={() => { setDialog(null); navigate(`${root}/runs`); }}>View task in runs</Button> : checkState !== "waiting" && <Button onClick={() => setCheckState("waiting")}>Check again</Button>}</DialogFooter>
      </div> : dialog === "rotate" ? <DialogFooter><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button onClick={() => { setKeyVisible(true); setStage("credentials"); setDialog(null); }}>Replace key</Button></DialogFooter> : tested ? <div className="space-y-4"><div role="status" className="flex items-start gap-3 rounded-md bg-muted p-4"><CheckCircle2 className="h-5 w-5 text-(--status-task-done)" /><div><p className="text-sm font-medium">{dialog === "routine" ? "Test task created" : "Sample event accepted"}</p><p className="text-xs text-muted-foreground">{dialog === "routine" ? "PAP-123 · Verify production deployment v2.8.4" : "Authentication passed. No task was created. Next, send a test event from your app to verify its setup."}</p></div></div><DialogFooter><Button onClick={() => { const showRuns = dialog === "routine"; setDialog(null); if (showRuns) navigate(`${root}/runs`); }}>{dialog === "routine" ? "View runs" : "Done"}</Button></DialogFooter></div> : <div className="space-y-4"><div className="space-y-2"><Label htmlFor="test-payload">Sample event</Label><textarea id="test-payload" rows={5} value={payload} onChange={(event) => setPayload(event.target.value)} className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs" />{payloadError && <p role="alert" className="text-xs text-destructive">{payloadError}</p>}</div><p className="text-xs text-muted-foreground">Storybook preview: this test uses simulated data.</p><DialogFooter><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button onClick={() => { if (!validatePayload()) return; setTested(true);  }}>{dialog === "routine" ? "Run test" : "Send sample event"}</Button></DialogFooter></div>}
    </DialogContent></Dialog>
  </div>;
}

function Prototype(props: Props) {
  return <WebhookReview signingMode={props.sender === "github" ? "github_hmac" : "bearer"} state={props.page === "triggers" ? "configured" : props.page} preview={<WebhookPrototypePage key={`${props.stage}:${props.sender}:${props.triggerKind}:${props.scheduleSaved}:${props.wizardStep}:${props.expandedWebhook ?? false}`} {...props} />} />;
}
const meta = {
  title: "Product/Routines/Webhooks UX preview",
  component: Prototype,
  parameters: { layout: "fullscreen" },
  args: { stage: "setup", sender: "custom", page: "triggers", triggerKind: "choose", wizardStep: 0, scheduleSaved: false, checkResult: "waiting" },
  argTypes: { triggerKind: { control: "radio", options: ["choose", "schedule", "webhook"] }, scheduleSaved: { control: "boolean" }, checkResult: { control: "select", options: ["waiting", "received", "rejected", "no_event"] }, stage: { control: "select", options: ["setup", "credentials", "waiting", "received", "failure"] }, sender: { control: "radio", options: ["custom", "github"] }, page: { control: "radio", options: ["triggers", "overview", "activity"] } },
} satisfies Meta<typeof Prototype>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Setup: Story = { name: "01 · Choose trigger" };
export const ConnectYourApp: Story = { name: "02 · Connect your app", args: { triggerKind: "webhook", wizardStep: 1 } };
export const CheckConnection: Story = { name: "03 · Check connection", args: { triggerKind: "webhook", wizardStep: 2 } };
export const WaitingForFirstEvent: Story = { name: "04 · Waiting for first event", args: { stage: "waiting", expandedWebhook: true } };
export const ReceivingEvents: Story = { name: "05 · Receiving events", args: { stage: "received", expandedWebhook: true } };
export const AuthenticationError: Story = { name: "06 · Fix authentication", args: { stage: "failure", expandedWebhook: true } };
export const GitHubSetup: Story = { name: "07 · Connect GitHub", args: { sender: "github", triggerKind: "webhook", wizardStep: 1 } };
export const Overview: Story = { name: "08 · Routine overview", args: { stage: "received", page: "overview" } };
export const Activity: Story = { name: "09 · Human-readable activity", args: { stage: "received", page: "activity" } };
export const InteractiveWalkthrough: Story = {
  name: "10 · Setup walkthrough", play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("radio", { name: /When another app sends a webhook/ }));
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await expect(canvas.getByRole("button", { name: "Copy for your agent" })).toBeVisible();
    await expect(canvas.queryByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Check connection" }));
    const dialog = within(canvasElement.ownerDocument.body);
    await expect(await dialog.findByText("Waiting for an event from your app…")).toBeVisible();
    await expect(dialog.getByText("Send an event from your app")).toBeVisible();
    await expect(dialog.getByText("Events received during setup won’t start the routine or create tasks.")).toBeVisible();
  },
};

export const Schedule: Story = { name: "11 · Set up a schedule", args: { triggerKind: "schedule", wizardStep: 1 } };
export const ScheduleAndWebhook: Story = { name: "12 · Schedule and webhook together", args: { stage: "waiting", scheduleSaved: true } };
export const ConnectionReceived: Story = { ...CheckConnection, name: "13 · Connection check · Event received", args: { triggerKind: "webhook", wizardStep: 2, checkResult: "received" } };
export const ConnectionRejected: Story = { ...CheckConnection, name: "14 · Connection check · Invalid key", args: { triggerKind: "webhook", wizardStep: 2, checkResult: "rejected" } };
export const ConnectionNoEvent: Story = { ...CheckConnection, name: "15 · Connection check · Nothing arrived", args: { triggerKind: "webhook", wizardStep: 2, checkResult: "no_event" } };
export const ScheduleWalkthrough: Story = { name: "16 · Schedule walkthrough", play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("radio", { name: /On a schedule/ }));
  await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
  await userEvent.click(canvas.getByRole("button", { name: "Review schedule" }));
  await userEvent.click(canvas.getByRole("button", { name: "Add schedule" }));
  await expect(canvas.getByText("Every weekday at 09:00")).toBeVisible();
  await expect(canvas.getByRole("navigation", { name: "Routine navigation" })).toBeVisible();
} };

export const EditWebhook: Story = { name: "17 · Edit webhook in its card", args: { stage: "waiting", scheduleSaved: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Edit webhook" }));
  await expect(canvas.getByRole("button", { name: "Copy Webhook URL" })).toBeVisible();
  await expect(canvas.getByRole("navigation", { name: "Routine navigation" })).toBeVisible();
} };
export const EditSchedule: Story = { name: "18 · Edit schedule in its card", args: { stage: "waiting", scheduleSaved: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Edit schedule" }));
  await userEvent.selectOptions(canvas.getByRole("combobox", { name: "Repeat" }), "daily");
  await userEvent.click(canvas.getByRole("button", { name: "Save schedule" }));
  await expect(canvas.getByRole("heading", { name: "Every day at 09:00" })).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Edit webhook" })).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "Edit schedule" }));
  await expect(canvas.getByRole("combobox", { name: "Repeat" })).toHaveValue("daily");
} };
export const RemoveTriggers: Story = { name: "19 · Remove and restore triggers", args: { stage: "waiting", scheduleSaved: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Remove schedule" }));
  await expect(canvas.queryByRole("button", { name: "Edit schedule" })).not.toBeInTheDocument();
  await expect(canvas.getByRole("button", { name: "Edit webhook" })).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "Remove webhook" }));
  await expect(canvas.queryByRole("button", { name: "Edit webhook" })).not.toBeInTheDocument();
  await userEvent.click(canvas.getByRole("button", { name: "Undo remove schedule" }));
  await userEvent.click(canvas.getByRole("button", { name: "Undo remove webhook" }));
  await expect(canvas.getByRole("button", { name: "Edit schedule" })).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Edit webhook" })).toBeVisible();
} };
