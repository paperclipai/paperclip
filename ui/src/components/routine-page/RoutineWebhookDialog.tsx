import { useEffect, useState } from "react";
import type { RoutineTrigger } from "@paperclipai/shared";
import { AlertCircle, Check, CheckCircle2, GitBranch, Globe, PauseCircle, Radio } from "lucide-react";
import { webhookAgentInstructions, webhookInstructionSigningMode } from "@/components/routine-triggers/webhook-instructions";
import { AgentInstructions, CopyField } from "@/components/routine-triggers/WebhookFields";
import { WebhookUrlWarning } from "@/components/routine-triggers/WebhookUrlWarning";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { WEBHOOK_STATUS_COPY, webhookStatusKey, webhookTitle, type WebhookStatusKey } from "./routine-summary";

export type WebhookSender = "custom" | "github";

export type RoutineWebhookDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routineTitle: string;
  /** False while the routine is paused or has no default agent: real events are rejected. */
  routineActive?: boolean;
  /** `null` while choosing what to connect; the saved webhook afterwards. */
  trigger: RoutineTrigger | null;
  /** The key, available only right after the webhook is created or its key is replaced. */
  secret?: string | null;
  busy?: boolean;
  error?: string | null;
  onCreate: (sender: WebhookSender) => void;
  onReplaceKey: () => void;
  onSetPaused: (paused: boolean) => void;
  onRemove: () => void;
  /** A finished webhook put back into test mode: events are checked but never start the routine. */
  testing?: boolean;
  /** Omit to hide "Test webhook". */
  onStartTest?: () => void;
  onFinishTest?: () => void;
};

const SENDERS = [
  { sender: "custom", label: "Another app or script", Icon: Globe },
  { sender: "github", label: "GitHub", Icon: GitBranch },
] as const;

const STATUS_LOOK: Record<WebhookStatusKey, { icon: typeof Radio; tone: string }> = {
  setup: { icon: Radio, tone: "text-muted-foreground" },
  setup_testing: { icon: Radio, tone: "text-muted-foreground" },
  testing: { icon: Radio, tone: "text-muted-foreground" },
  waiting: { icon: Radio, tone: "text-muted-foreground" },
  receiving: { icon: CheckCircle2, tone: "text-(--status-task-done)" },
  rejected: { icon: AlertCircle, tone: "text-destructive" },
  test_rejected: { icon: AlertCircle, tone: "text-destructive" },
  test_received: { icon: CheckCircle2, tone: "text-(--status-task-done)" },
  ignored_while_paused: { icon: PauseCircle, tone: "text-muted-foreground" },
  paused: { icon: PauseCircle, tone: "text-muted-foreground" },
};

export function RoutineWebhookDialog({
  open,
  onOpenChange,
  routineTitle,
  routineActive = true,
  trigger,
  secret = null,
  busy = false,
  error = null,
  onCreate,
  onReplaceKey,
  onSetPaused,
  onRemove,
  testing = false,
  onStartTest,
  onFinishTest,
}: RoutineWebhookDialogProps) {
  const [sender, setSender] = useState<WebhookSender>("custom");
  useEffect(() => {
    if (open && !trigger) setSender("custom");
  }, [open, trigger]);

  const github = trigger?.signingMode === "github_hmac";
  const bearer = trigger?.signingMode === "bearer";
  const inTest = testing && Boolean(trigger?.setupPending);
  const statusKey = trigger ? webhookStatusKey(trigger, { routineActive, testing: inTest }) : null;
  const status = statusKey ? { ...STATUS_LOOK[statusKey], ...WEBHOOK_STATUS_COPY[statusKey] } : null;
  const testReceived = statusKey === "test_received";
  const StatusIcon = status?.icon;
  const statusDetail = status?.detail;
  const canTest = Boolean(onStartTest) && trigger != null && !trigger.setupPending && trigger.enabled;
  const url = trigger?.webhookUrl ?? "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-(--sz-calc-18) flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="px-6 pb-4 pt-6">
          <DialogTitle>{trigger ? webhookTitle(trigger) : "Add webhook"}</DialogTitle>
          <DialogDescription>
            {trigger
              ? `Starts “${routineTitle}” when ${github ? "GitHub" : "another app"} sends an event.`
              : "Start this routine when something happens in another app."}
          </DialogDescription>
        </DialogHeader>

        <fieldset disabled={busy} className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6">
          {!trigger ? (
            <div role="radiogroup" aria-label="What’s sending the webhook?" className="flex flex-col gap-2">
              {SENDERS.map(({ sender: value, label, Icon }) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm focus-within:ring-2 focus-within:ring-ring",
                    sender === value ? "border-primary bg-accent/30" : "border-border hover:bg-accent/20",
                  )}
                >
                  <input
                    className="sr-only"
                    type="radio"
                    name="webhook-sender"
                    checked={sender === value}
                    onChange={() => setSender(value)}
                  />
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="flex-1">{label}</span>
                  {sender === value ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
                </label>
              ))}
            </div>
          ) : (
            <>
              {status && StatusIcon ? (
                <div role="status" className="flex items-start gap-3 rounded-md bg-muted/40 p-3">
                  <StatusIcon className={cn("mt-0.5 h-4 w-4 shrink-0", status.tone)} aria-hidden="true" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="text-sm font-medium">{status.title}</p>
                    <p className="text-xs text-muted-foreground">{statusDetail}</p>
                  </div>
                  {canTest ? (
                    <Button variant="outline" size="sm" className="shrink-0" onClick={onStartTest}>Test webhook</Button>
                  ) : null}
                </div>
              ) : null}
              <WebhookUrlWarning url={url} />
              <CopyField label={github ? "Payload URL" : "Webhook URL"} value={url} />
              {trigger.signingMode === "hmac_sha256" ? (
                <p className="text-sm text-muted-foreground">
                  Sign the timestamp, a period, and the exact JSON body with HMAC-SHA256. Send X-Paperclip-Timestamp and
                  X-Paperclip-Signature: sha256=&lt;signature&gt;.
                </p>
              ) : null}
              {trigger.signingMode === "none" ? (
                <p className="text-sm text-muted-foreground">This webhook has no key. Its URL is the shared secret, so keep it private.</p>
              ) : secret ? (
                <CopyField
                  label={github ? "Secret" : bearer ? "Authorization header value" : "Secret key"}
                  value={!github && bearer ? `Bearer ${secret}` : secret}
                  help="Copy it now. It’s hidden after you close this."
                />
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">The secret key is hidden.</p>
                  <Button variant="outline" size="sm" onClick={onReplaceKey}>Replace key</Button>
                </div>
              )}
              {/* Instructions follow the signing mode; with no known mode (a restored webhook before its refresh) none are shown. */}
              {trigger.signingMode && (secret || trigger.signingMode === "none") ? (
                <AgentInstructions
                  value={webhookAgentInstructions(
                    github ? "github" : "custom",
                    routineTitle,
                    url,
                    secret ?? "",
                    Boolean(trigger.setupPending),
                    webhookInstructionSigningMode(trigger.signingMode),
                  )}
                />
              ) : null}
            </>
          )}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </fieldset>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-6 py-4">
          {!trigger ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button disabled={busy} onClick={() => onCreate(sender)}>{busy ? "Creating…" : "Create webhook"}</Button>
            </>
          ) : inTest ? (
            <>
              <p className="text-sm text-muted-foreground">Testing. No tasks are created.</p>
              <Button disabled={busy} onClick={onFinishTest}>Finish testing</Button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1">
                <Button variant="ghost" className="text-muted-foreground" disabled={busy} onClick={onRemove}>Remove</Button>
                {trigger.setupPending ? null : (
                  <Button variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => onSetPaused(trigger.enabled)}>
                    {trigger.enabled ? "Pause" : "Resume"}
                  </Button>
                )}
              </div>
              <Button onClick={() => onOpenChange(false)}>
                {trigger.setupPending && !testReceived ? "Finish without testing" : "Done"}
              </Button>
            </>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
