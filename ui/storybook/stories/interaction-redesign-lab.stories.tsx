import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ListChecks,
  MessageSquareQuote,
  SquareCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  pendingAskUserQuestionsInteraction,
  pendingRequestCheckboxConfirmationInteraction,
  planApprovalAcceptedRequestConfirmationInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import { cn } from "@/lib/utils";

/**
 * Interaction Redesign Lab — PAP-12679 (parent PAP-12669).
 *
 * Candidate "lighter" treatments for issue-thread interaction cards, all
 * rendered from the same shared fixtures so visual weight can be compared
 * directly. Variants 01–10 are the original exploration; Variant 11 is the
 * post-review (PAP-12696) recommended hybrid: V03 shell + V01 body.
 * Each variant renders the same trio:
 *
 *   1. pending ask_user_questions (two questions, single + multi select)
 *   2. pending request_checkbox_confirmation (four options)
 *   3. resolved (accepted) plan request_confirmation
 *
 * These are lab prototypes, not production components. The winning direction
 * gets implemented for real in IssueThreadInteractionCard in P4.
 */

// ---------------------------------------------------------------------------
// Shared fixture data
// ---------------------------------------------------------------------------

const qInteraction = pendingAskUserQuestionsInteraction;
const qPayload = qInteraction.payload;
const cbInteraction = pendingRequestCheckboxConfirmationInteraction;
const cbPayload = cbInteraction.payload;
const cbOptions = cbPayload.options ?? [];
const doneInteraction = planApprovalAcceptedRequestConfirmationInteraction;

const AGENT_NAME = "CodexCoder";
const RESOLVER_NAME = "Riley Board";
const CREATED_LABEL = "Apr 20";
const RESOLVED_LABEL = "Apr 20";

// ---------------------------------------------------------------------------
// Shared local state helpers (lab-only interactivity)
// ---------------------------------------------------------------------------

function useAnswers() {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  function toggle(questionId: string, optionId: string, mode: "single" | "multi") {
    setAnswers((prev) => {
      const current = prev[questionId] ?? [];
      if (mode === "single") {
        return { ...prev, [questionId]: current[0] === optionId ? [] : [optionId] };
      }
      return {
        ...prev,
        [questionId]: current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId],
      };
    });
  }
  return { answers, toggle };
}

function useChecked() {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }
  return { checked, toggle };
}

// ---------------------------------------------------------------------------
// Thread scaffolding so every variant is judged in feed context
// ---------------------------------------------------------------------------

function ThreadComment({
  author,
  initials,
  body,
  time,
}: {
  author: string;
  initials: string;
  body: string;
  time: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
        {initials}
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-foreground">{author}</span>
          <span className="text-xs text-muted-foreground">{time}</span>
        </div>
        <p className="mt-0.5 text-sm leading-6 text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function ThreadScaffold({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <ThreadComment
        author={AGENT_NAME}
        initials="CX"
        time="2:09 PM"
        body="I finished the fixture audit. Before persistence work I need three decisions from the board — cards below."
      />
      {children}
      <ThreadComment
        author={RESOLVER_NAME}
        initials="RB"
        time="2:52 PM"
        body="Looking now — will answer the open items today."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant 01 — Compact card
// Keep the card, shrink everything: single-line header, xs type, tight rows.
// ---------------------------------------------------------------------------

function CompactHeader({
  icon: Icon,
  title,
  status,
  statusTone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  status: string;
  statusTone: "pending" | "done";
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{title}</span>
      <span
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
          statusTone === "pending"
            ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
            : "bg-green-500/10 text-green-600 dark:text-green-400",
        )}
      >
        {status}
      </span>
    </div>
  );
}

function Variant01Compact() {
  const { answers, toggle } = useAnswers();
  const { checked, toggle: toggleChecked } = useChecked();

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-card px-4 py-3">
        <CompactHeader icon={CircleHelp} title={qInteraction.title ?? ""} status="Needs answers" statusTone="pending" />
        <div className="mt-2.5 space-y-3">
          {qPayload.questions.map((question) => (
            <div key={question.id}>
              <div className="text-sm font-medium text-foreground">{question.prompt}</div>
              <div className="mt-1.5 flex flex-col gap-1">
                {(question.options ?? []).map((option) => {
                  const selected = (answers[question.id] ?? []).includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => toggle(question.id, option.id, question.selectionMode)}
                      className={cn(
                        "flex items-center gap-2 rounded-sm border px-2.5 py-2 text-left text-sm transition-colors",
                        selected
                          ? "border-primary/50 bg-primary/5 text-foreground"
                          : "border-border/60 text-muted-foreground hover:bg-accent/50",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-3.5 w-3.5 shrink-0 items-center justify-center border",
                          question.selectionMode === "single" ? "rounded-full" : "rounded-[3px]",
                          selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
                        )}
                      >
                        {selected ? <Check className="h-2.5 w-2.5" /> : null}
                      </span>
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-end gap-2 border-t border-border/60 pt-2.5">
          <Button size="xs" variant="ghost">
            Dismiss
          </Button>
          <Button size="xs">{qPayload.submitLabel ?? "Send answers"}</Button>
        </div>
      </div>

      <div className="rounded-md border border-border bg-card px-4 py-3">
        <CompactHeader icon={SquareCheck} title={cbInteraction.title ?? ""} status="Needs selection" statusTone="pending" />
        <div className="mt-2.5 flex flex-col gap-1">
          {cbOptions.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer items-start gap-2 rounded-sm px-1 py-1.5 text-sm text-foreground hover:bg-accent/50"
            >
              <Checkbox
                className="mt-0.5"
                checked={checked.has(option.id)}
                onCheckedChange={() => toggleChecked(option.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{option.label}</span>
                {option.description ? (
                  <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{option.description}</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
          <span className="text-xs text-muted-foreground">{checked.size} selected</span>
          <div className="flex gap-2">
            <Button size="xs" variant="ghost">
              {cbPayload.rejectLabel ?? "Request changes"}
            </Button>
            <Button size="xs">{cbPayload.acceptLabel ?? "Confirm"}</Button>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 px-1 py-1.5">
        <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{doneInteraction.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          Approved by {RESOLVER_NAME} · {RESOLVED_LABEL}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant 02 — Borderless inline
// No card chrome at all; a 2px status-colored accent bar carries identity.
// ---------------------------------------------------------------------------

function Variant02Borderless() {
  const { answers, toggle } = useAnswers();
  const { checked, toggle: toggleChecked } = useChecked();

  return (
    <div className="space-y-5">
      <div className="border-l-2 border-yellow-500/60 pl-4">
        <div className="text-xs text-muted-foreground">
          Questions · {AGENT_NAME} · {CREATED_LABEL}
        </div>
        <div className="mt-1 text-sm font-medium text-foreground">{qInteraction.title}</div>
        <div className="mt-3 space-y-3.5">
          {qPayload.questions.map((question) => (
            <div key={question.id}>
              <div className="text-sm text-foreground">{question.prompt}</div>
              <div className="mt-1.5 space-y-1">
                {(question.options ?? []).map((option) => {
                  const selected = (answers[question.id] ?? []).includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => toggle(question.id, option.id, question.selectionMode)}
                      className="flex min-h-8 w-full items-center gap-2 text-left text-sm"
                    >
                      <span
                        className={cn(
                          "flex h-3.5 w-3.5 shrink-0 items-center justify-center border",
                          question.selectionMode === "single" ? "rounded-full" : "rounded-[3px]",
                          selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
                        )}
                      >
                        {selected ? <Check className="h-2.5 w-2.5" /> : null}
                      </span>
                      <span className={selected ? "text-foreground" : "text-muted-foreground"}>{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <Button size="xs">{qPayload.submitLabel ?? "Send answers"}</Button>
          <Button size="xs" variant="ghost">
            Dismiss
          </Button>
        </div>
      </div>

      <div className="border-l-2 border-yellow-500/60 pl-4">
        <div className="text-xs text-muted-foreground">
          Confirm selection · {AGENT_NAME} · {CREATED_LABEL}
        </div>
        <div className="mt-1 text-sm font-medium text-foreground">{cbPayload.prompt}</div>
        <div className="mt-2 space-y-1">
          {cbOptions.map((option) => (
            <label key={option.id} className="flex min-h-8 cursor-pointer items-center gap-2 text-sm text-foreground">
              <Checkbox checked={checked.has(option.id)} onCheckedChange={() => toggleChecked(option.id)} />
              {option.label}
            </label>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <Button size="xs">{cbPayload.acceptLabel ?? "Confirm"}</Button>
          <Button size="xs" variant="ghost">
            {cbPayload.rejectLabel ?? "Request changes"}
          </Button>
        </div>
      </div>

      <div className="border-l-2 border-green-500/50 pl-4">
        <span className="text-sm text-muted-foreground">
          <Check className="mr-1.5 inline h-3.5 w-3.5 text-green-600 dark:text-green-400" />
          <span className="font-medium text-foreground">Plan approved</span> — {RESOLVER_NAME}, {RESOLVED_LABEL}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant 03 — Collapsed by default
// One-line summary row; expanding reveals the form. Resolved is permanently one line.
// ---------------------------------------------------------------------------

function CollapsedRow({
  icon: Icon,
  title,
  meta,
  tone,
  badge,
  badgeTone = "pending",
  defaultOpen,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  meta: string;
  tone: "pending" | "done";
  badge?: string;
  badgeTone?: "pending" | "done";
  defaultOpen?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const expandable = Boolean(children);
  const row = (
    <>
      {expandable ? (
        open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )
      ) : (
        <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
      )}
      <Icon
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          tone === "pending" ? "text-yellow-600 dark:text-yellow-400" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{title}</span>
      {badge ? (
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
            badgeTone === "pending"
              ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
              : "bg-green-500/10 text-green-600 dark:text-green-400",
          )}
        >
          {badge}
        </span>
      ) : null}
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{meta}</span>
    </>
  );
  return (
    <div className="rounded-md border border-border bg-card">
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-h-10 w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-accent/40"
        >
          {row}
        </button>
      ) : (
        <div className="flex min-h-10 w-full items-center gap-2 px-3 py-2">{row}</div>
      )}
      {expandable && open ? <div className="border-t border-border/60 px-3 pb-3 pt-2.5">{children}</div> : null}
    </div>
  );
}

function Variant03PendingRows({ open }: { open: boolean }) {
  const { answers, toggle } = useAnswers();
  const { checked, toggle: toggleChecked } = useChecked();
  const pendingOpen = open;

  return (
    <>
      <CollapsedRow
        icon={CircleHelp}
        title={qInteraction.title ?? ""}
        meta={`2 questions · ${AGENT_NAME}`}
        tone="pending"
        badge="Needs answers"
        defaultOpen={pendingOpen}
      >
        <div className="space-y-3">
          {qPayload.questions.map((question) => (
            <div key={question.id}>
              <div className="text-sm font-medium text-foreground">{question.prompt}</div>
              <div className="mt-1.5 space-y-1">
                {(question.options ?? []).map((option) => {
                  const selected = (answers[question.id] ?? []).includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => toggle(question.id, option.id, question.selectionMode)}
                      className="flex min-h-8 w-full items-center gap-2 text-left text-sm"
                    >
                      <span
                        className={cn(
                          "flex h-3.5 w-3.5 shrink-0 items-center justify-center border",
                          question.selectionMode === "single" ? "rounded-full" : "rounded-[3px]",
                          selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
                        )}
                      >
                        {selected ? <Check className="h-2.5 w-2.5" /> : null}
                      </span>
                      <span className={selected ? "text-foreground" : "text-muted-foreground"}>{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="ghost">
              Dismiss
            </Button>
            <Button size="xs">{qPayload.submitLabel ?? "Send answers"}</Button>
          </div>
        </div>
      </CollapsedRow>

      <CollapsedRow
        icon={SquareCheck}
        title={cbInteraction.title ?? ""}
        meta={`${cbOptions.length} options · ${AGENT_NAME}`}
        tone="pending"
        badge="Needs selection"
        defaultOpen={pendingOpen}
      >
        <div className="space-y-1">
          {cbOptions.map((option) => (
            <label key={option.id} className="flex min-h-8 cursor-pointer items-center gap-2 text-sm text-foreground">
              <Checkbox checked={checked.has(option.id)} onCheckedChange={() => toggleChecked(option.id)} />
              {option.label}
            </label>
          ))}
        </div>
        <div className="mt-2.5 flex justify-end gap-2">
          <Button size="xs" variant="ghost">
            {cbPayload.rejectLabel ?? "Request changes"}
          </Button>
          <Button size="xs">{cbPayload.acceptLabel ?? "Confirm"}</Button>
        </div>
      </CollapsedRow>
    </>
  );
}

function Variant03Collapsed({ collapsePending }: { collapsePending?: boolean }) {
  // Semantic default-open: pending + required interactions auto-expand;
  // resolved (and optional) rows stay permanently collapsed.
  return (
    <div className="space-y-2">
      <Variant03PendingRows open={!collapsePending} />
      <CollapsedRow
        icon={ListChecks}
        title={`${doneInteraction.title} — approved`}
        meta={`${RESOLVER_NAME} · ${RESOLVED_LABEL}`}
        tone="done"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant 04 — Chat-native
// The interaction is an agent message bubble with an inline action row.
// ---------------------------------------------------------------------------

function AgentBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
        CX
      </div>
      <div className="min-w-0 max-w-2xl">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-foreground">{AGENT_NAME}</span>
          <span className="text-xs text-muted-foreground">2:18 PM</span>
        </div>
        <div className="mt-1 rounded-lg rounded-tl-sm bg-accent/40 px-3.5 py-2.5">{children}</div>
      </div>
    </div>
  );
}

function Variant04ChatNative() {
  const { answers, toggle } = useAnswers();
  const { checked, toggle: toggleChecked } = useChecked();

  return (
    <div className="space-y-4">
      <AgentBubble>
        <p className="text-sm text-foreground">{qPayload.title}</p>
        <div className="mt-2.5 space-y-3">
          {qPayload.questions.map((question) => (
            <div key={question.id}>
              <div className="text-sm font-medium text-foreground">{question.prompt}</div>
              <div className="mt-1 flex flex-col gap-0.5">
                {(question.options ?? []).map((option) => {
                  const selected = (answers[question.id] ?? []).includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => toggle(question.id, option.id, question.selectionMode)}
                      className="flex min-h-8 w-full items-center gap-2 text-left text-sm"
                    >
                      <span
                        className={cn(
                          "flex h-3.5 w-3.5 shrink-0 items-center justify-center border",
                          question.selectionMode === "single" ? "rounded-full" : "rounded-[3px]",
                          selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
                        )}
                      >
                        {selected ? <Check className="h-2.5 w-2.5" /> : null}
                      </span>
                      <span className={selected ? "text-foreground" : "text-muted-foreground"}>{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-border/50 pt-2.5">
          <Button size="xs">{qPayload.submitLabel ?? "Send answers"}</Button>
          <span className="text-xs text-muted-foreground">2 required</span>
        </div>
      </AgentBubble>

      <AgentBubble>
        <p className="text-sm text-foreground">{cbPayload.prompt}</p>
        <div className="mt-2 space-y-1">
          {cbOptions.map((option) => (
            <label key={option.id} className="flex min-h-8 cursor-pointer items-center gap-2 text-sm text-foreground">
              <Checkbox checked={checked.has(option.id)} onCheckedChange={() => toggleChecked(option.id)} />
              {option.label}
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-border/50 pt-2.5">
          <Button size="xs">{cbPayload.acceptLabel ?? "Confirm"}</Button>
          <Button size="xs" variant="ghost">
            {cbPayload.rejectLabel ?? "Request changes"}
          </Button>
        </div>
      </AgentBubble>

      <div className="flex items-start gap-2.5">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
          CX
        </div>
        <div className="min-w-0 max-w-2xl">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-medium text-foreground">{AGENT_NAME}</span>
            <span className="text-xs text-muted-foreground">2:30 PM</span>
          </div>
          <div className="mt-1 rounded-lg rounded-tl-sm bg-accent/40 px-3.5 py-2.5">
            <p className="text-sm text-foreground">{doneInteraction.payload.prompt}</p>
          </div>
          <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-600 dark:text-green-400">
            <Check className="h-3 w-3" />
            Approved by {RESOLVER_NAME} · {RESOLVED_LABEL}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant 05 — Trimmed body + footer bar
// Prompt + controls only; secondary copy behind "Show details"; actions live
// in a compact muted footer bar.
// ---------------------------------------------------------------------------

function DetailsDisclosure({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
      >
        {open ? "Hide details" : "Show details"}
      </button>
      {open ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{text}</p> : null}
    </div>
  );
}

function Variant05TrimmedFooter() {
  const { answers, toggle } = useAnswers();
  const { checked, toggle: toggleChecked } = useChecked();

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-md border border-border bg-card">
        <div className="px-4 pb-3 pt-3">
          <div className="text-sm font-semibold text-foreground">{qInteraction.title}</div>
          <div className="mt-2.5 space-y-3">
            {qPayload.questions.map((question) => (
              <div key={question.id}>
                <div className="text-sm text-foreground">{question.prompt}</div>
                <div className="mt-1.5 space-y-1">
                  {(question.options ?? []).map((option) => {
                    const selected = (answers[question.id] ?? []).includes(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => toggle(question.id, option.id, question.selectionMode)}
                        className="flex min-h-8 w-full items-center gap-2 text-left text-sm"
                      >
                        <span
                          className={cn(
                            "flex h-3.5 w-3.5 shrink-0 items-center justify-center border",
                            question.selectionMode === "single" ? "rounded-full" : "rounded-[3px]",
                            selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
                          )}
                        >
                          {selected ? <Check className="h-2.5 w-2.5" /> : null}
                        </span>
                        <span className={selected ? "text-foreground" : "text-muted-foreground"}>{option.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <DetailsDisclosure text={`${qInteraction.summary ?? ""} ${qPayload.questions[0]?.helpText ?? ""}`} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/40 px-4 py-2">
          <span className="text-xs text-muted-foreground">
            {AGENT_NAME} asked · {CREATED_LABEL}
          </span>
          <div className="flex gap-2">
            <Button size="xs" variant="ghost">
              Dismiss
            </Button>
            <Button size="xs">{qPayload.submitLabel ?? "Send answers"}</Button>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-border bg-card">
        <div className="px-4 pb-3 pt-3">
          <div className="text-sm font-semibold text-foreground">{cbPayload.prompt}</div>
          <div className="mt-2 space-y-1">
            {cbOptions.map((option) => (
              <label key={option.id} className="flex min-h-8 cursor-pointer items-center gap-2 text-sm text-foreground">
                <Checkbox checked={checked.has(option.id)} onCheckedChange={() => toggleChecked(option.id)} />
                {option.label}
              </label>
            ))}
          </div>
          <div className="mt-2">
            <DetailsDisclosure text={cbPayload.detailsMarkdown ?? ""} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/40 px-4 py-2">
          <span className="text-xs text-muted-foreground">{checked.size} selected</span>
          <div className="flex gap-2">
            <Button size="xs" variant="ghost">
              {cbPayload.rejectLabel ?? "Request changes"}
            </Button>
            <Button size="xs">{cbPayload.acceptLabel ?? "Confirm"}</Button>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 overflow-hidden rounded-md border border-border bg-card px-4 py-2">
        <span className="min-w-0 truncate text-sm text-foreground">{doneInteraction.title}</span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
          <Check className="h-3.5 w-3.5" />
          Approved · {RESOLVER_NAME} · {RESOLVED_LABEL}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant 06 — Dense two-column form
// Label left, control right; divider rows like a properties panel.
// ---------------------------------------------------------------------------

function TwoColRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 px-4 py-2.5 sm:grid-cols-[minmax(0,220px)_1fr] sm:gap-4">
      <div className="text-xs font-medium leading-5 text-muted-foreground">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Variant06DenseTwoColumn() {
  const { answers, toggle } = useAnswers();
  const { checked, toggle: toggleChecked } = useChecked();

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-card">
        <div className="border-b border-border px-4 py-2 text-sm font-semibold text-foreground">
          {qInteraction.title}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {AGENT_NAME} · {CREATED_LABEL}
          </span>
        </div>
        <div className="divide-y divide-border/60">
          {qPayload.questions.map((question) => (
            <TwoColRow key={question.id} label={question.prompt}>
              <div className="flex flex-col gap-1">
                {(question.options ?? []).map((option) => {
                  const selected = (answers[question.id] ?? []).includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => toggle(question.id, option.id, question.selectionMode)}
                      className="flex min-h-8 items-center gap-2 text-left text-sm"
                    >
                      <span
                        className={cn(
                          "flex h-3.5 w-3.5 shrink-0 items-center justify-center border",
                          question.selectionMode === "single" ? "rounded-full" : "rounded-[3px]",
                          selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
                        )}
                      >
                        {selected ? <Check className="h-2.5 w-2.5" /> : null}
                      </span>
                      <span className={selected ? "text-foreground" : "text-muted-foreground"}>{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </TwoColRow>
          ))}
          <div className="flex justify-end gap-2 px-4 py-2">
            <Button size="xs" variant="ghost">
              Dismiss
            </Button>
            <Button size="xs">{qPayload.submitLabel ?? "Send answers"}</Button>
          </div>
        </div>
      </div>

      <div className="rounded-md border border-border bg-card">
        <div className="border-b border-border px-4 py-2 text-sm font-semibold text-foreground">
          {cbInteraction.title}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {AGENT_NAME} · {CREATED_LABEL}
          </span>
        </div>
        <div className="divide-y divide-border/60">
          <TwoColRow label={cbPayload.prompt}>
            <div className="grid gap-1 sm:grid-cols-2">
              {cbOptions.map((option) => (
                <label key={option.id} className="flex min-h-8 cursor-pointer items-center gap-2 text-sm text-foreground">
                  <Checkbox checked={checked.has(option.id)} onCheckedChange={() => toggleChecked(option.id)} />
                  {option.label}
                </label>
              ))}
            </div>
          </TwoColRow>
          <div className="flex justify-end gap-2 px-4 py-2">
            <Button size="xs" variant="ghost">
              {cbPayload.rejectLabel ?? "Request changes"}
            </Button>
            <Button size="xs">{cbPayload.acceptLabel ?? "Confirm"}</Button>
          </div>
        </div>
      </div>

      <div className="rounded-md border border-border bg-card">
        <TwoColRow label={doneInteraction.title}>
          <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
            <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
            Approved · {RESOLVER_NAME} · {RESOLVED_LABEL}
          </span>
        </TwoColRow>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant 07 — Chip answers
// Every option is a selectable pill; forms read as sentences plus chips.
// ---------------------------------------------------------------------------

function Chip({
  selected,
  onClick,
  children,
}: {
  selected?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-foreground hover:bg-accent/60",
      )}
    >
      {selected ? <Check className="h-3 w-3" /> : null}
      {children}
    </button>
  );
}

function Variant07Chips() {
  const { answers, toggle } = useAnswers();
  const { checked, toggle: toggleChecked } = useChecked();

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-card px-4 py-3">
        <div className="text-sm font-medium text-foreground">{qInteraction.title}</div>
        <div className="mt-3 space-y-3">
          {qPayload.questions.map((question) => (
            <div key={question.id}>
              <div className="text-sm text-muted-foreground">{question.prompt}</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {(question.options ?? []).map((option) => (
                  <Chip
                    key={option.id}
                    selected={(answers[question.id] ?? []).includes(option.id)}
                    onClick={() => toggle(question.id, option.id, question.selectionMode)}
                  >
                    {option.label}
                  </Chip>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2.5">
          <span className="text-xs text-muted-foreground">
            {AGENT_NAME} · {CREATED_LABEL}
          </span>
          <Button size="xs">{qPayload.submitLabel ?? "Send answers"}</Button>
        </div>
      </div>

      <div className="rounded-md border border-border bg-card px-4 py-3">
        <div className="text-sm font-medium text-foreground">{cbPayload.prompt}</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {cbOptions.map((option) => (
            <Chip key={option.id} selected={checked.has(option.id)} onClick={() => toggleChecked(option.id)}>
              {option.label}
            </Chip>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2.5">
          <span className="text-xs text-muted-foreground">{checked.size} selected</span>
          <div className="flex gap-2">
            <Button size="xs" variant="ghost">
              {cbPayload.rejectLabel ?? "Request changes"}
            </Button>
            <Button size="xs">{cbPayload.acceptLabel ?? "Confirm"}</Button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-4 py-2.5">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{doneInteraction.title}</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-600 dark:text-green-400">
          <Check className="h-3 w-3" />
          Approved
        </span>
        <span className="text-xs text-muted-foreground">
          {RESOLVER_NAME} · {RESOLVED_LABEL}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant 08 — Banner + disclosure
// A thin one-line banner in the thread; the full form opens in a popover.
// ---------------------------------------------------------------------------

function Variant08Banner() {
  const { answers, toggle } = useAnswers();
  const { checked, toggle: toggleChecked } = useChecked();

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/5 px-3 py-1.5">
        <CircleHelp className="h-3.5 w-3.5 shrink-0 text-yellow-600 dark:text-yellow-400" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{qInteraction.title}</span>
        <Popover defaultOpen>
          <PopoverTrigger asChild>
            <Button size="xs" variant="outline">
              Answer
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-96 p-4">
            <div className="text-sm font-medium text-foreground">{qPayload.title}</div>
            <div className="mt-3 space-y-3">
              {qPayload.questions.map((question) => (
                <div key={question.id}>
                  <div className="text-sm text-foreground">{question.prompt}</div>
                  <div className="mt-1.5 space-y-1">
                    {(question.options ?? []).map((option) => {
                      const selected = (answers[question.id] ?? []).includes(option.id);
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => toggle(question.id, option.id, question.selectionMode)}
                          className="flex min-h-8 w-full items-center gap-2 text-left text-sm"
                        >
                          <span
                            className={cn(
                              "flex h-3.5 w-3.5 shrink-0 items-center justify-center border",
                              question.selectionMode === "single" ? "rounded-full" : "rounded-[3px]",
                              selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
                            )}
                          >
                            {selected ? <Check className="h-2.5 w-2.5" /> : null}
                          </span>
                          <span className={selected ? "text-foreground" : "text-muted-foreground"}>
                            {option.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex justify-end">
              <Button size="xs">{qPayload.submitLabel ?? "Send answers"}</Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex items-center gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/5 px-3 py-1.5">
        <SquareCheck className="h-3.5 w-3.5 shrink-0 text-yellow-600 dark:text-yellow-400" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{cbInteraction.title}</span>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="xs" variant="outline">
              Review
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-4">
            <div className="text-sm text-foreground">{cbPayload.prompt}</div>
            <div className="mt-2 space-y-1">
              {cbOptions.map((option) => (
                <label key={option.id} className="flex min-h-8 cursor-pointer items-center gap-2 text-sm text-foreground">
                  <Checkbox checked={checked.has(option.id)} onCheckedChange={() => toggleChecked(option.id)} />
                  {option.label}
                </label>
              ))}
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button size="xs" variant="ghost">
                {cbPayload.rejectLabel ?? "Request changes"}
              </Button>
              <Button size="xs">{cbPayload.acceptLabel ?? "Confirm"}</Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-500/5 px-3 py-1.5">
        <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{doneInteraction.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          Approved · {RESOLVER_NAME} · {RESOLVED_LABEL}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant 09 — Split surface
// One-line stub in the thread; the whole form lives in a dialog.
// ---------------------------------------------------------------------------

function Variant09Split({ dialogOpen }: { dialogOpen?: boolean }) {
  const { answers, toggle } = useAnswers();
  const { checked, toggle: toggleChecked } = useChecked();

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 py-1">
        <CircleHelp className="h-3.5 w-3.5 shrink-0 text-yellow-600 dark:text-yellow-400" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          <span className="font-medium">{AGENT_NAME}</span> asks: {qInteraction.title}
        </span>
        <Dialog defaultOpen={dialogOpen}>
          <DialogTrigger asChild>
            <Button size="xs" variant="outline">
              Open form
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="text-base">{qPayload.title}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {qPayload.questions.map((question) => (
                <div key={question.id}>
                  <div className="text-sm font-medium text-foreground">{question.prompt}</div>
                  {question.helpText ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{question.helpText}</p>
                  ) : null}
                  <div className="mt-2 space-y-1">
                    {(question.options ?? []).map((option) => {
                      const selected = (answers[question.id] ?? []).includes(option.id);
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => toggle(question.id, option.id, question.selectionMode)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-sm border px-2.5 py-1.5 text-left text-sm",
                            selected
                              ? "border-primary/50 bg-primary/5 text-foreground"
                              : "border-border/60 text-muted-foreground hover:bg-accent/50",
                          )}
                        >
                          <span
                            className={cn(
                              "flex h-3.5 w-3.5 shrink-0 items-center justify-center border",
                              question.selectionMode === "single" ? "rounded-full" : "rounded-[3px]",
                              selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
                            )}
                          >
                            {selected ? <Check className="h-2.5 w-2.5" /> : null}
                          </span>
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost">
                  Cancel
                </Button>
                <Button size="sm">{qPayload.submitLabel ?? "Send answers"}</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex items-center gap-2 py-1">
        <SquareCheck className="h-3.5 w-3.5 shrink-0 text-yellow-600 dark:text-yellow-400" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          <span className="font-medium">{AGENT_NAME}</span> needs a selection: {cbInteraction.title}
        </span>
        <Dialog>
          <DialogTrigger asChild>
            <Button size="xs" variant="outline">
              Open form
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base">{cbInteraction.title}</DialogTitle>
            </DialogHeader>
            <div className="space-y-1.5">
              {cbOptions.map((option) => (
                <label key={option.id} className="flex min-h-8 cursor-pointer items-center gap-2 text-sm text-foreground">
                  <Checkbox checked={checked.has(option.id)} onCheckedChange={() => toggleChecked(option.id)} />
                  {option.label}
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost">
                {cbPayload.rejectLabel ?? "Request changes"}
              </Button>
              <Button size="sm">{cbPayload.acceptLabel ?? "Confirm"}</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex items-center gap-2 py-1">
        <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{doneInteraction.title}</span> — approved by {RESOLVER_NAME},{" "}
          {RESOLVED_LABEL}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant 10 — Minimal monochrome
// No icons, no badges, no status color. Typography-only hierarchy.
// ---------------------------------------------------------------------------

function Variant10Monochrome() {
  const { answers, toggle } = useAnswers();
  const { checked, toggle: toggleChecked } = useChecked();

  return (
    <div className="divide-y divide-border border-y border-border">
      <div className="py-3.5">
        <div className="text-xs text-muted-foreground">
          Questions — {AGENT_NAME}, {CREATED_LABEL}
        </div>
        <div className="mt-1.5 text-sm font-medium text-foreground">{qInteraction.title}</div>
        <div className="mt-3 space-y-3">
          {qPayload.questions.map((question) => (
            <div key={question.id}>
              <div className="text-sm text-foreground">{question.prompt}</div>
              <div className="mt-1 space-y-0.5">
                {(question.options ?? []).map((option) => {
                  const selected = (answers[question.id] ?? []).includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => toggle(question.id, option.id, question.selectionMode)}
                      className="flex min-h-8 w-full items-baseline gap-2 text-left text-sm"
                    >
                      <span className="w-4 shrink-0 font-mono text-xs text-muted-foreground">
                        {selected ? "[x]" : "[ ]"}
                      </span>
                      <span
                        className={cn(
                          selected ? "font-medium text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {option.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex gap-4 text-sm">
          <button type="button" className="font-medium text-foreground underline underline-offset-4">
            {qPayload.submitLabel ?? "Send answers"}
          </button>
          <button type="button" className="text-muted-foreground underline-offset-4 hover:underline">
            Dismiss
          </button>
        </div>
      </div>

      <div className="py-3.5">
        <div className="text-xs text-muted-foreground">
          Confirm selection — {AGENT_NAME}, {CREATED_LABEL}
        </div>
        <div className="mt-1.5 text-sm font-medium text-foreground">{cbPayload.prompt}</div>
        <div className="mt-2 space-y-0.5">
          {cbOptions.map((option) => {
            const selected = checked.has(option.id);
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => toggleChecked(option.id)}
                className="flex min-h-8 w-full items-baseline gap-2 text-left text-sm"
              >
                <span className="w-4 shrink-0 font-mono text-xs text-muted-foreground">
                  {selected ? "[x]" : "[ ]"}
                </span>
                <span className={selected ? "font-medium text-foreground" : "text-muted-foreground"}>
                  {option.label}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex gap-4 text-sm">
          <button type="button" className="font-medium text-foreground underline underline-offset-4">
            {cbPayload.acceptLabel ?? "Confirm"}
          </button>
          <button type="button" className="text-muted-foreground underline-offset-4 hover:underline">
            {cbPayload.rejectLabel ?? "Request changes"}
          </button>
        </div>
      </div>

      <div className="py-3.5">
        <div className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{doneInteraction.title}</span> — approved by {RESOLVER_NAME},{" "}
          {RESOLVED_LABEL}.
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant 11 — Hybrid (recommended, post PAP-12696 review)
// V03 shell + V01 body: pending + required interactions auto-expand into a
// compact card with real controls; resolved (and optional) interactions are a
// permanent bare one-liner with no card fill. Secondary copy sits behind
// V05's "Show details" disclosure.
// ---------------------------------------------------------------------------

function Variant11Hybrid() {
  const { answers, toggle } = useAnswers();
  const { checked, toggle: toggleChecked } = useChecked();

  return (
    <div className="space-y-2">
      <CollapsedRow
        icon={CircleHelp}
        title={qInteraction.title ?? ""}
        meta={`2 questions · ${AGENT_NAME}`}
        tone="pending"
        badge="Needs answers"
        defaultOpen
      >
        <div className="space-y-3">
          {qPayload.questions.map((question) => (
            <div key={question.id}>
              <div className="text-sm font-medium text-foreground">{question.prompt}</div>
              <div className="mt-1.5 flex flex-col gap-1">
                {(question.options ?? []).map((option) => {
                  const selected = (answers[question.id] ?? []).includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => toggle(question.id, option.id, question.selectionMode)}
                      className={cn(
                        "flex items-center gap-2 rounded-sm border px-2.5 py-2 text-left text-sm transition-colors",
                        selected
                          ? "border-primary/50 bg-primary/5 text-foreground"
                          : "border-border/60 text-muted-foreground hover:bg-accent/50",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-3.5 w-3.5 shrink-0 items-center justify-center border",
                          question.selectionMode === "single" ? "rounded-full" : "rounded-[3px]",
                          selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
                        )}
                      >
                        {selected ? <Check className="h-2.5 w-2.5" /> : null}
                      </span>
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <DetailsDisclosure text={`${qInteraction.summary ?? ""} ${qPayload.questions[0]?.helpText ?? ""}`} />
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="ghost">
              Dismiss
            </Button>
            <Button size="xs">{qPayload.submitLabel ?? "Send answers"}</Button>
          </div>
        </div>
      </CollapsedRow>

      <CollapsedRow
        icon={SquareCheck}
        title={cbInteraction.title ?? ""}
        meta={`${cbOptions.length} options · ${AGENT_NAME}`}
        tone="pending"
        badge="Needs selection"
        defaultOpen
      >
        <div className="flex flex-col gap-1">
          {cbOptions.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer items-start gap-2 rounded-sm px-1 py-1.5 text-sm text-foreground hover:bg-accent/50"
            >
              <Checkbox
                className="mt-0.5"
                checked={checked.has(option.id)}
                onCheckedChange={() => toggleChecked(option.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{option.label}</span>
                {option.description ? (
                  <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{option.description}</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
        <div className="mt-2">
          <DetailsDisclosure text={cbPayload.detailsMarkdown ?? ""} />
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{checked.size} selected</span>
          <div className="flex gap-2">
            <Button size="xs" variant="ghost">
              {cbPayload.rejectLabel ?? "Request changes"}
            </Button>
            <Button size="xs">{cbPayload.acceptLabel ?? "Confirm"}</Button>
          </div>
        </div>
      </CollapsedRow>

      <div className="flex min-h-10 items-center gap-2 px-3 py-2">
        <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{doneInteraction.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          Approved by {RESOLVER_NAME} · {RESOLVED_LABEL}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant 12 — V03 styles, everything toggled open (Dotta's direction)
// Exactly the Variant 03 look, but every row — including the resolved one —
// keeps a chevron toggle and defaults to expanded. Resolved signal moves from
// the leading check into a green "Approved" badge; the expanded resolved body
// shows the original prompt plus the outcome line.
// ---------------------------------------------------------------------------

function Variant12ExpandedByDefault() {
  return (
    <div className="space-y-2">
      <Variant03PendingRows open />
      <CollapsedRow
        icon={ListChecks}
        title={doneInteraction.title ?? ""}
        meta={`${RESOLVER_NAME} · ${RESOLVED_LABEL}`}
        tone="done"
        badge="Approved"
        badgeTone="done"
        defaultOpen
      >
        <div className="space-y-1.5">
          <p className="text-sm text-muted-foreground">{doneInteraction.payload.prompt}</p>
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
            <span>
              <span className="font-medium text-foreground">Plan approved</span> — {RESOLVER_NAME}, {RESOLVED_LABEL} ·
              plan revision 4
            </span>
          </p>
        </div>
      </CollapsedRow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Story plumbing
// ---------------------------------------------------------------------------

const variants: Array<{
  index: number;
  name: string;
  thesis: string;
  render: () => React.ReactNode;
}> = [
  {
    index: 1,
    name: "Compact card",
    thesis: "Keep card identity; cut padding, type scale, badges. Resolved is a bare one-liner with no card chrome.",
    render: () => <Variant01Compact />,
  },
  {
    index: 2,
    name: "Borderless inline",
    thesis: "No card chrome. A 2px status accent bar and small caps eyebrow carry all identity.",
    render: () => <Variant02Borderless />,
  },
  {
    index: 3,
    name: "Collapsed by default",
    thesis:
      "Semantic folding: pending + required rows auto-expand, resolved rows are permanently one line. Collapsed pending rows keep a needs-you badge.",
    render: () => <Variant03Collapsed />,
  },
  {
    index: 4,
    name: "Chat-native",
    thesis:
      "Interactions are agent message bubbles with real single/multi controls and an action row; resolved is a reply chip.",
    render: () => <Variant04ChatNative />,
  },
  {
    index: 5,
    name: "Trimmed body + footer bar",
    thesis: "Prompt and controls only; secondary copy behind 'Show details'; actions in a muted footer bar.",
    render: () => <Variant05TrimmedFooter />,
  },
  {
    index: 6,
    name: "Dense two-column form",
    thesis: "Properties-panel grammar: question label left, controls right, divider rows.",
    render: () => <Variant06DenseTwoColumn />,
  },
  {
    index: 7,
    name: "Chip answers",
    thesis: "Options are selectable pills; the form reads as prompts plus chips, no option descriptions.",
    render: () => <Variant07Chips />,
  },
  {
    index: 8,
    name: "Banner + disclosure",
    thesis: "Thin one-line banners in the thread; the full form opens in a popover. (First popover shown open.)",
    render: () => <Variant08Banner />,
  },
  {
    index: 9,
    name: "Split surface",
    thesis: "One-line stubs in the thread; forms live in a dialog. Thread cost is near zero.",
    render: () => <Variant09Split />,
  },
  {
    index: 10,
    name: "Minimal monochrome",
    thesis: "No icons, badges, or status color. Typography-only hierarchy with mono checkmarks.",
    render: () => <Variant10Monochrome />,
  },
  {
    index: 11,
    name: "Hybrid — V03 shell + V01 body (recommended)",
    thesis:
      "Post-review favorite: pending + required = V01's compact expanded card inside V03's row shell; resolved & optional = permanent bare one-liner, no card fill. Details behind V05's disclosure.",
    render: () => <Variant11Hybrid />,
  },
  {
    index: 12,
    name: "V03 styles, expanded by default (Dotta's pick)",
    thesis:
      "Variant 03's exact styling, but every row — including resolved — keeps its chevron toggle and defaults to expanded. Resolved signal moves to a green Approved badge; the open resolved body shows the prompt and outcome.",
    render: () => <Variant12ExpandedByDefault />,
  },
];

function StoryFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-6">{children}</main>
    </div>
  );
}

function VariantPage({ index }: { index: number }) {
  const variant = variants[index - 1];
  return (
    <StoryFrame>
      <section className="paperclip-story__frame overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <div className="paperclip-story__label">
            Redesign lab · Variant {String(variant.index).padStart(2, "0")}
          </div>
          <h2 className="mt-1 text-xl font-semibold">{variant.name}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{variant.thesis}</p>
        </div>
        <div className="p-5">
          <ThreadScaffold>{variant.render()}</ThreadScaffold>
        </div>
      </section>
    </StoryFrame>
  );
}

const meta = {
  title: "Issue Thread/Interaction Redesign Lab",
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const AllVariants: Story = {
  render: () => (
    <StoryFrame>
      <section className="paperclip-story__frame overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <div className="paperclip-story__label">PAP-12679 · Redesign lab</div>
          <h2 className="mt-1 text-xl font-semibold">Interaction redesign lab — 10 variants + hybrid + Dotta's pick</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Every variant renders the identical fixture trio: pending questions, pending checkbox confirmation,
            resolved plan approval. Compare vertical cost, scannability, and how quiet the resolved state gets.
            Variant 11 is the post-review (PAP-12696) recommendation; Variant 12 is Dotta&apos;s direction: V03
            styles with every toggle present and expanded by default.
          </p>
        </div>
        <div className="space-y-10 p-5">
          {variants.map((variant) => (
            <section key={variant.index}>
              <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border/60 pb-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {String(variant.index).padStart(2, "0")}
                </span>
                <h3 className="text-sm font-semibold text-foreground">{variant.name}</h3>
                <p className="text-xs text-muted-foreground">{variant.thesis}</p>
              </div>
              <ThreadScaffold>{variant.render()}</ThreadScaffold>
            </section>
          ))}
        </div>
      </section>
    </StoryFrame>
  ),
};

export const V01CompactCard: Story = { render: () => <VariantPage index={1} /> };
export const V02BorderlessInline: Story = { render: () => <VariantPage index={2} /> };
export const V03CollapsedByDefault: Story = { render: () => <VariantPage index={3} /> };
export const V04ChatNative: Story = { render: () => <VariantPage index={4} /> };
export const V05TrimmedFooterBar: Story = { render: () => <VariantPage index={5} /> };
export const V06DenseTwoColumn: Story = { render: () => <VariantPage index={6} /> };
export const V07ChipAnswers: Story = { render: () => <VariantPage index={7} /> };
export const V08BannerDisclosure: Story = { render: () => <VariantPage index={8} /> };
export const V09SplitSurface: Story = { render: () => <VariantPage index={9} /> };
export const V09SplitSurfaceDialogOpen: Story = {
  render: () => (
    <StoryFrame>
      <section className="paperclip-story__frame overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <div className="paperclip-story__label">Redesign lab · Variant 09</div>
          <h2 className="mt-1 text-xl font-semibold">Split surface — dialog open</h2>
        </div>
        <div className="p-5">
          <ThreadScaffold>
            <Variant09Split dialogOpen />
          </ThreadScaffold>
        </div>
      </section>
    </StoryFrame>
  ),
};
export const V10MinimalMonochrome: Story = { render: () => <VariantPage index={10} /> };
export const V11HybridRecommended: Story = { render: () => <VariantPage index={11} /> };
export const V12ExpandedByDefault: Story = { render: () => <VariantPage index={12} /> };
export const V03CollapsedPendingFolded: Story = {
  render: () => (
    <StoryFrame>
      <section className="paperclip-story__frame overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <div className="paperclip-story__label">Redesign lab · Variant 03</div>
          <h2 className="mt-1 text-xl font-semibold">Collapsed by default — pending rows folded</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            The scan state: folded pending rows keep the yellow icon plus a needs-you badge so required decisions
            stay discoverable without expansion.
          </p>
        </div>
        <div className="p-5">
          <ThreadScaffold>
            <Variant03Collapsed collapsePending />
          </ThreadScaffold>
        </div>
      </section>
    </StoryFrame>
  ),
};
