import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  Check,
  ChevronRight,
  FileText,
  LockKeyhole,
  Mail,
  Play,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { IssueStatusBadge } from "@/components/StatusBadge";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatPresentationProvider } from "@/components/task-chat/presentation-mode";

// Scripted product exploration. Uses the real task bubbles and composer, never a provider API.
type Scenario = "outbound" | "inbound";
type Phase = "start" | "sent" | "followup" | "failed";
type TaskView = "parent" | "email";
const inbox = "support@agentmail.to";
const peer = "alex@example.test";
const outboundBody =
  "Hi Alex,\n\nCan you confirm Friday, September 18 for the pilot delivery? We’re ready on our side.\n\nThanks,\nSupport";
const incomingBody =
  "Hi,\n\nCan you confirm Friday, September 18 for the pilot delivery? I’ve attached our delivery notes.\n\nThanks,\nAlex";
const replyBody =
  "Hi Alex,\n\nFriday, September 18 works for us. We’ll send the final delivery details tomorrow.\n\nThanks,\nSupport";

function AgentIdentity() {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <Avatar size="sm">
        <AvatarFallback>
          <AgentIcon icon="bot" className="size-3.5" />
        </AvatarFallback>
      </Avatar>
      Support
    </span>
  );
}
function InternalMessage({
  author = "agent",
  children,
}: {
  author?: "agent" | "human";
  children: string;
}) {
  return (
    <TaskChatBubble
      animateEntry={false}
      item={{
        id: children,
        kind: "message",
        author,
        authorName: author === "agent" ? "Support" : "You",
        agentIcon: "bot",
        text: children,
        timestamp: "11:04 AM",
      }}
    />
  );
}
function MailEvent({
  direction,
  body,
  subject = "Pilot delivery · September 18",
  outcome = "delivered",
  attachment = false,
  at = "11:04 AM",
  onAttachment,
}: {
  direction: "inbound" | "outbound";
  body: string;
  subject?: string;
  outcome?: "delivered" | "failed";
  attachment?: boolean;
  at?: string;
  onAttachment: () => void;
}) {
  const incoming = direction === "inbound";
  return (
    <article
      className="overflow-hidden rounded-xl border border-border"
      aria-label={
        incoming
          ? "Received email from Alex"
          : outcome === "failed"
            ? "Failed email from Support"
            : "Email sent by Support"
      }
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-5 py-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          {incoming ? (
            <ArrowDownLeft className="size-4" />
          ) : (
            <ArrowUpRight className="size-4" />
          )}
          {incoming
            ? "Email received"
            : outcome === "failed"
              ? "Email not delivered"
              : "Email sent"}
        </span>
        <span className="text-xs text-muted-foreground">{at}</span>
      </header>
      <div className="space-y-4 p-5">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {incoming ? (
              <>
                <Avatar size="sm">
                  <AvatarFallback>AL</AvatarFallback>
                </Avatar>
                <span className="text-sm font-medium">Alex</span>
                <Badge variant="outline">External</Badge>
              </>
            ) : (
              <AgentIdentity />
            )}
            <span className="text-xs text-muted-foreground">
              {incoming ? peer : inbox}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            To: {incoming ? inbox : peer}
          </p>
        </div>
        <h3 className="text-sm font-semibold">{subject}</h3>
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{body}</p>
        {attachment && (
          <Button variant="outline" size="sm" onClick={onAttachment}>
            <FileText className="size-4" />
            Delivery notes.txt
            <span className="text-xs text-muted-foreground">1 KB</span>
          </Button>
        )}
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Email details</summary>
          <dl className="grid grid-cols-2 gap-2 pt-3">
            <dt>From</dt>
            <dd className="break-all">{incoming ? peer : inbox}</dd>
            <dt>To</dt>
            <dd className="break-all">{incoming ? inbox : peer}</dd>
            <dt>Subject</dt>
            <dd>{subject}</dd>
            <dt>Provider</dt>
            <dd>AgentMail</dd>
          </dl>
        </details>
      </div>
      {!incoming && (
        <footer className="flex items-center gap-2 border-t border-border px-5 py-3 text-xs">
          {outcome === "failed" ? (
            <>
              <TriangleAlert className="size-3.5 text-destructive" />
              <span>Delivery failed · Recipient address was rejected</span>
            </>
          ) : (
            <>
              <Check className="size-3.5" />
              <span>Delivered to Alex’s mail server</span>
            </>
          )}
        </footer>
      )}
    </article>
  );
}
function EmailTaskExperience({
  scenario = "outbound",
  initialPhase = "start",
  initialView = "parent",
}: {
  scenario?: Scenario;
  initialPhase?: Phase;
  initialView?: TaskView;
}) {
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [view, setView] = useState<TaskView>(
    scenario === "inbound" ? "email" : initialView,
  );
  const [notes, setNotes] = useState<{ task: TaskView; text: string }[]>([]);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const emailTask = view === "email";
  const sent = phase !== "start";
  const outbound = scenario === "outbound";
  const taskKey = !emailTask ? "PAP-240" : outbound ? "PAP-241" : "PAP-242";
  const taskTitle = !emailTask
    ? "Coordinate the pilot delivery"
    : "Pilot delivery · September 18";
  const blocked = phase === "failed";
  const received = !outbound || phase === "followup";
  const actionLabel =
    phase === "start"
      ? outbound
        ? "Play agent sending email"
        : "Play agent replying"
      : phase === "sent"
        ? "Receive Alex’s next reply"
        : "Restart scenario";
  function advance() {
    if (phase === "start") setPhase("sent");
    else if (phase === "sent") {
      setPhase("followup");
      setView("email");
    } else {
      setPhase("start");
      setView(outbound ? "parent" : "email");
      setNotes([]);
    }
  }
  function mail(
    direction: "inbound" | "outbound",
    body: string,
    extra: Partial<Parameters<typeof MailEvent>[0]> = {},
  ) {
    return (
      <MailEvent
        direction={direction}
        body={body}
        onAttachment={() => setAttachmentOpen(true)}
        {...extra}
      />
    );
  }
  return (
    <TaskChatPresentationProvider mode="streamlined">
      <div className="min-h-screen bg-background text-foreground">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-6 py-3">
          <div className="space-y-1">
            <p className="text-xs font-medium">
              Design preview ·{" "}
              {outbound
                ? "Agent starts an email conversation"
                : "An email arrives for an agent"}
            </p>
            <p className="text-xs text-muted-foreground">
              Scripted agent actions. No real emails are sent.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={advance}>
            {phase === "start" ? (
              <Play className="size-3.5" />
            ) : phase === "sent" ? (
              <Mail className="size-3.5" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
            {actionLabel}
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
          <nav
            aria-label="Task breadcrumb"
            className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
          >
            <span>Tasks</span>
            <ChevronRight className="size-3.5 shrink-0" />
            {outbound && emailTask && (
              <>
                <button
                  className="shrink-0 hover:text-foreground"
                  onClick={() => setView("parent")}
                >
                  PAP-240
                </button>
                <ChevronRight className="size-3.5 shrink-0" />
              </>
            )}
            <span className="truncate text-foreground">{taskTitle}</span>
            <span className="shrink-0 font-mono text-xs">{taskKey}</span>
          </nav>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPropertiesOpen(!propertiesOpen)}
          >
            {propertiesOpen ? "Hide details" : "Show details"}
          </Button>
        </div>
        <div className="mx-auto flex max-w-6xl flex-col lg:flex-row">
          <main className="min-w-0 flex-1 space-y-6 p-6">
            <header className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-xl font-bold">{taskTitle}</h1>
                <IssueStatusBadge status={blocked ? "blocked" : "in_progress"} />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <AgentIdentity />
                {emailTask && (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Mail className="size-3.5" />
                    {inbox}
                  </span>
                )}
              </div>
            </header>
            {emailTask && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-y border-border py-3 text-xs text-muted-foreground">
                <span>
                  {outbound
                    ? "Started by Support"
                    : "Created from incoming email"}{" "}
                  ·{" "}
                  {received
                    ? phase === "followup"
                      ? "New reply in this task"
                      : "Alex is an external participant"
                    : "Waiting for Alex’s reply"}
                </span>
                {outbound && (
                  <button
                    onClick={() => setView("parent")}
                    className="underline underline-offset-4"
                  >
                    Parent task PAP-240
                  </button>
                )}
              </div>
            )}
            <div className="space-y-6" aria-label="Task conversation">
              {!emailTask ? (
                <>
                  <InternalMessage author="human">
                    Email Alex at alex@example.test and confirm Friday,
                    September 18 for the pilot delivery.
                  </InternalMessage>
                  <InternalMessage>
                    {sent
                      ? blocked
                        ? "The email couldn’t be delivered. I’ve kept the failed send in its task so we can check the address."
                        : "I emailed Alex. I’ll handle their reply in the email task."
                      : "I’ll email Alex from support@agentmail.to and keep the conversation in a child task."}
                  </InternalMessage>
                  {sent && (
                    <button
                      className="flex w-full items-center gap-3 rounded-xl border border-border p-4 text-left hover:bg-accent/40"
                      onClick={() => setView("email")}
                    >
                      <Mail className="size-5 shrink-0" />
                      <span className="min-w-0 flex-1 space-y-1">
                        <span className="block text-xs font-mono text-muted-foreground">
                          PAP-241 · Email task
                        </span>
                        <span className="block text-sm font-medium">
                          Pilot delivery · September 18
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {blocked ? "Delivery failed" : "Email delivered"} · To
                          Alex
                        </span>
                      </span>
                      <ArrowRight className="size-4 shrink-0" />
                    </button>
                  )}
                </>
              ) : (
                <>
                  {outbound ? (
                    <>
                      {mail("outbound", outboundBody, {
                        outcome: blocked ? "failed" : "delivered",
                      })}
                      <InternalMessage>
                        {blocked
                          ? "Alex’s address was rejected. Please confirm the recipient before I try again."
                          : "Email delivered. I’m keeping this task open for Alex’s reply."}
                      </InternalMessage>
                    </>
                  ) : (
                    <>
                      {mail("inbound", incomingBody, {
                        attachment: true,
                        at: "11:02 AM",
                      })}
                      <InternalMessage>
                        {sent
                          ? "The delivery plan confirms Friday. I replied to Alex with the date and next steps."
                          : "I’m checking the delivery plan before replying to Alex."}
                      </InternalMessage>
                      {sent &&
                        mail("outbound", replyBody, {
                          outcome: blocked ? "failed" : "delivered",
                        })}
                    </>
                  )}
                  {phase === "followup" && (
                    <>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="h-px flex-1 bg-border" />
                        New email · Same task
                        <span className="h-px flex-1 bg-border" />
                      </div>
                      {mail(
                        "inbound",
                        "Friday works. Can we aim for delivery before noon?\n\nAlex",
                        { at: "11:12 AM" },
                      )}
                      <InternalMessage>
                        Alex asked about a morning delivery. I’ll check the
                        schedule before replying.
                      </InternalMessage>
                    </>
                  )}
                </>
              )}
              {notes
                .filter((note) => note.task === view)
                .map((note, index) => (
                  <div key={index} className="space-y-4">
                    <InternalMessage author="human">
                      {note.text}
                    </InternalMessage>
                    <InternalMessage>
                      Noted. This stays in the task.
                    </InternalMessage>
                  </div>
                ))}
            </div>
            <div className="space-y-2 border-t border-border pt-5">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <LockKeyhole className="size-3.5" />
                Message Support · Internal
              </div>
              <TaskChatComposer
                key={view}
                workMode="standard"
                placeholder="Message Support…"
                onAdd={(body) => {
                  setNotes((current) => [
                    ...current,
                    { task: view, text: body },
                  ]);
                }}
              />
            </div>
          </main>
          {propertiesOpen && (
            <aside
              aria-label="Task details"
              className="w-full shrink-0 space-y-6 border-t border-border p-6 lg:w-64 lg:border-l lg:border-t-0"
            >
              <div className="space-y-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Task details
                </h2>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Assigned to</p>
                  <AgentIdentity />
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Created by</p>
                  <p className="text-sm">
                    {!emailTask
                      ? "You"
                      : outbound
                        ? "Support"
                        : "Incoming email"}
                  </p>
                </div>
                {emailTask && (
                  <>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        Email address
                      </p>
                      <p className="break-all text-sm">{inbox}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        External participant
                      </p>
                      <p className="text-sm">Alex</p>
                      <p className="break-all text-xs text-muted-foreground">
                        {peer}
                      </p>
                    </div>
                  </>
                )}
                {outbound && (emailTask || sent) && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      {emailTask ? "Parent task" : "Child task"}
                    </p>
                    <button
                      onClick={() => setView(emailTask ? "parent" : "email")}
                      className="text-left text-sm underline underline-offset-4"
                    >
                      {emailTask
                        ? "PAP-240 · Coordinate the pilot delivery"
                        : "PAP-241 · Pilot delivery"}
                    </button>
                  </div>
                )}
              </div>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">
                  How email works here
                </summary>
                <p className="pt-3 leading-relaxed">
                  Your messages go to Support. Only an explicit email action
                  sends mail to Alex. Each email appears once, with its delivery
                  status. Replies return to this task.
                </p>
              </details>
            </aside>
          )}
        </div>
        <Dialog open={attachmentOpen} onOpenChange={setAttachmentOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delivery notes.txt</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <p className="text-xs text-muted-foreground">
                Attachment from Alex · Sample file
              </p>
              <p>Pilot delivery: Friday, September 18.</p>
              <p>
                Please confirm the delivery date. Morning delivery preferred.
              </p>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </TaskChatPresentationProvider>
  );
}
const meta = {
  title: "Connections/AgentMail tasks",
  component: EmailTaskExperience,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EmailTaskExperience>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Outbound: Story = {
  name: "01 · Agent initiates email",
  args: { scenario: "outbound" },
};
export const OutboundSent: Story = {
  name: "02 · Parent links to email task",
  args: { scenario: "outbound", initialPhase: "sent" },
};
export const EmailChildTask: Story = {
  name: "03 · Outbound email task",
  args: { scenario: "outbound", initialPhase: "sent", initialView: "email" },
};
export const Incoming: Story = {
  name: "04 · Incoming email creates a task",
  args: { scenario: "inbound" },
};
export const AgentReply: Story = {
  name: "05 · Agent replies by email",
  args: { scenario: "inbound", initialPhase: "sent" },
};
export const IncomingFollowUp: Story = {
  name: "06 · Next reply stays in the task",
  args: { scenario: "inbound", initialPhase: "followup" },
};
export const FailedDelivery: Story = {
  name: "07 · Agent surfaces delivery failure",
  args: { scenario: "outbound", initialPhase: "failed", initialView: "email" },
};
export const VerifyOutbound: Story = {
  name: "Verification · Outbound journey",
  args: { scenario: "outbound" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Play agent sending email" }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: /PAP-241 · Email task/ }),
    );
    await expect(
      canvas.getByRole("article", { name: "Email sent by Support" }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Receive Alex’s next reply" }),
    );
    await expect(
      canvas.getByRole("article", { name: "Received email from Alex" }),
    ).toBeVisible();
    await expect(canvas.getAllByRole("article")).toHaveLength(2);
  },
};
export const VerifyInbound: Story = {
  name: "Verification · Inbound journey",
  args: { scenario: "inbound" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("article", { name: "Received email from Alex" }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Play agent replying" }),
    );
    await expect(
      canvas.getByRole("article", { name: "Email sent by Support" }),
    ).toBeVisible();
    await expect(canvas.getAllByRole("article")).toHaveLength(2);
  },
};
