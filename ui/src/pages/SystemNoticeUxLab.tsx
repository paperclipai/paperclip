import type { ReactNode } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SystemNotice } from "@/components/SystemNotice";
import { systemNoticeFixtures } from "@/fixtures/systemNoticeFixtures";
import { cn } from "@/lib/utils";
import {
  CircleDashed,
  FlaskConical,
  Layers,
  ListChecks,
  Sparkles,
} from "lucide-react";

function LabSection({
  id,
  eyebrow,
  title,
  description,
  accentClassName,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  description: string;
  accentClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "rounded-[28px] border border-border/70 bg-background/85 p-4 shadow-[0_24px_60px_rgba(15,23,42,0.08)] sm:p-5",
        accentClassName,
      )}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            {eyebrow}
          </div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function FixtureFrame({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        <CircleDashed className="h-3.5 w-3.5" />
        {caption}
      </div>
      {children}
    </div>
  );
}

function MockUserBubble({
  authorName,
  body,
  alignEnd,
}: {
  authorName: string;
  body: string;
  alignEnd?: boolean;
}) {
  return (
    <div className={cn("flex items-start gap-2.5", alignEnd && "justify-end")}>
      {!alignEnd ? (
        <Avatar size="sm" className="shrink-0">
          <AvatarFallback>{authorName.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
      ) : null}
      <div className={cn("flex min-w-0 max-w-[85%] flex-col", alignEnd && "items-end")}>
        <div
          className={cn(
            "mb-1 px-1 text-sm font-medium text-foreground",
            alignEnd ? "text-right" : "text-left",
          )}
        >
          {authorName}
        </div>
        <div className="min-w-0 max-w-full rounded-2xl bg-muted px-4 py-2.5 text-sm leading-6 text-foreground">
          {body}
        </div>
      </div>
      {alignEnd ? (
        <Avatar size="sm" className="shrink-0">
          <AvatarFallback>{authorName.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
      ) : null}
    </div>
  );
}

function MockAgentBubble({ agentName, body }: { agentName: string; body: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <Avatar size="sm" className="shrink-0">
        <AvatarFallback>{agentName.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 max-w-[85%] flex-col">
        <div className="mb-1 px-1 text-sm font-medium text-foreground">{agentName}</div>
        <div className="min-w-0 max-w-full rounded-2xl border border-border/70 bg-background px-4 py-2.5 text-sm leading-6 text-foreground">
          {body}
        </div>
      </div>
    </div>
  );
}

const checklist = [
  "One container per system notice — no nested chat bubble",
  "Tone communicated by icon + label, never color alone",
  "Operational evidence hidden behind Details, expanded only on demand",
  "Issue, agent, and run metadata render as typed link rows, not raw markdown",
  "Hierarchy visibly distinct from user (right-aligned) and agent (left-aligned) bubbles",
];

export function SystemNoticeUxLab() {
  const fixtureById = new Map(systemNoticeFixtures.map((f) => [f.id, f] as const));

  const warningCollapsed = fixtureById.get("warning-collapsed")!;
  const warningExpanded = fixtureById.get("warning-expanded")!;
  const dangerCollapsed = fixtureById.get("danger-collapsed")!;
  const dangerExpanded = fixtureById.get("danger-expanded")!;
  const neutralCollapsed = fixtureById.get("neutral-collapsed")!;
  const neutralExpanded = fixtureById.get("neutral-expanded")!;
  const warningNoDetails = fixtureById.get("warning-no-details")!;

  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-[32px] border border-border/70 bg-[linear-gradient(135deg,rgba(245,158,11,0.10),transparent_28%),linear-gradient(180deg,rgba(8,145,178,0.08),transparent_44%),var(--background)] shadow-[0_30px_80px_rgba(15,23,42,0.10)]">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_320px]">
          <div className="p-6 sm:p-7">
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/25 bg-amber-500/[0.08] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-amber-700 dark:text-amber-300">
              <FlaskConical className="h-3.5 w-3.5" />
              System Notice Lab
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">
              First-class system notice treatment
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
              Replaces the current pattern where a Paperclip-authored warning renders inside a user-style
              chat bubble. The notice is one container, system-styled, with hidden-by-default operational
              metadata. Tone is conveyed by icon, label, and color together so it stays accessible.
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.18em]">
                PAP-3525 plan
              </Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.18em]">
                phase 1 — UX
              </Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.18em]">
                tones: warning · danger · neutral
              </Badge>
            </div>
          </div>

          <aside className="border-t border-border/60 bg-background/70 p-6 lg:border-l lg:border-t-0">
            <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              <ListChecks className="h-4 w-4 text-amber-700 dark:text-amber-300" />
              What this lab proves
            </div>
            <div className="space-y-3">
              {checklist.map((line) => (
                <div
                  key={line}
                  className="rounded-2xl border border-border/70 bg-background/85 px-4 py-3 text-sm text-muted-foreground"
                >
                  {line}
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>

      <LabSection
        id="tones"
        eyebrow="Tone matrix"
        title="Three tones, two states"
        description="Each tone pairs a unique icon and tone label so the notice is recognizable without color. Collapsed is the default; the Details affordance reveals operational metadata only when reviewers ask for it."
        accentClassName="bg-[linear-gradient(180deg,rgba(245,158,11,0.05),transparent_28%),var(--background)]"
      >
        <div className="space-y-5">
          <FixtureFrame caption={warningCollapsed.caption}>
            <SystemNotice {...warningCollapsed} />
          </FixtureFrame>
          <FixtureFrame caption={warningExpanded.caption}>
            <SystemNotice {...warningExpanded} />
          </FixtureFrame>
          <FixtureFrame caption={dangerCollapsed.caption}>
            <SystemNotice {...dangerCollapsed} />
          </FixtureFrame>
          <FixtureFrame caption={dangerExpanded.caption}>
            <SystemNotice {...dangerExpanded} />
          </FixtureFrame>
          <FixtureFrame caption={neutralCollapsed.caption}>
            <SystemNotice {...neutralCollapsed} />
          </FixtureFrame>
          <FixtureFrame caption={neutralExpanded.caption}>
            <SystemNotice {...neutralExpanded} />
          </FixtureFrame>
          <FixtureFrame caption={warningNoDetails.caption}>
            <SystemNotice {...warningNoDetails} />
          </FixtureFrame>
        </div>
      </LabSection>

      <LabSection
        id="hierarchy"
        eyebrow="Hierarchy in thread"
        title="Distinct from user and agent comments"
        description="Side-by-side with adjacent comment types so reviewers can confirm the system row reads as a system row — full width, no avatar gutter, no chat bubble — while user and agent comments keep their existing rounded bubbles."
        accentClassName="bg-[linear-gradient(180deg,rgba(8,145,178,0.05),transparent_28%),var(--background)]"
      >
        <div className="space-y-4 rounded-2xl border border-border/70 bg-background/70 p-4">
          <MockUserBubble
            authorName="Riley Board"
            body="Why does this issue keep waking back up without a clear next step?"
            alignEnd
          />
          <MockAgentBubble
            agentName="CodexCoder"
            body="The previous run completed without picking a disposition. I'll wait for the new system notice to surface so the recovery owner is unambiguous."
          />
          <SystemNotice
            tone="danger"
            label="System alert"
            source={{ label: "Paperclip", href: "/PAP/agents" }}
            timestamp="2026-05-04T16:48:00.000Z"
            body="Paperclip could not resolve this issue's missing disposition automatically. The issue is blocked on a recovery owner."
            metadata={[
              {
                title: "Recovery owner",
                rows: [
                  {
                    kind: "issue",
                    label: "Recovery issue",
                    identifier: "PAP-3440",
                    href: "/PAP/issues/PAP-3440",
                    title: "Successful run handoff missing disposition",
                  },
                  {
                    kind: "agent",
                    label: "Owner",
                    name: "CTO",
                    href: "/PAP/agents/cto",
                  },
                ],
              },
              {
                title: "Run evidence",
                rows: [
                  {
                    kind: "run",
                    label: "Source run",
                    runId: "9cdba892-c7ca-4d93-8604-4843873b127c",
                    href: "/PAP/agents/codexcoder/runs/9cdba892-c7ca-4d93-8604-4843873b127c",
                    status: "succeeded",
                  },
                ],
              },
            ]}
          />
          <MockUserBubble
            authorName="Riley Board"
            body="Thanks — assigning the recovery owner now."
            alignEnd
          />
        </div>
      </LabSection>

      <div className="grid gap-5 xl:grid-cols-2">
        <LabSection
          eyebrow="Before"
          title="Today's nested treatment"
          description="The same content rendered through the existing user-bubble + warning-callout path. Two containers, same gray background as user comments, and the warning icon is forced inside a chat row."
          accentClassName="bg-[linear-gradient(180deg,rgba(244,63,94,0.05),transparent_28%),var(--background)]"
        >
          <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4">
            <div className="flex items-start gap-2.5">
              <Avatar size="sm" className="shrink-0">
                <AvatarFallback>YO</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 max-w-[85%] flex-col">
                <div className="mb-1 px-1 text-sm font-medium text-foreground">You</div>
                <div className="min-w-0 max-w-full rounded-2xl bg-muted px-4 py-2.5 text-sm leading-6 text-foreground">
                  <div className="rounded-md border border-red-500/35 bg-red-500/10 px-3 py-2.5 text-sm text-red-950 dark:text-red-100">
                    <div className="flex items-start gap-2">
                      <Sparkles className="mt-1 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" />
                      <div className="min-w-0">
                        <p className="m-0 font-semibold">Successful run handoff missing</p>
                        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[13px] leading-5">
                          <li>Source issue: PAP-3440</li>
                          <li>Source run: 9cdba892-c7ca-4d93-8604-4843873b127c</li>
                          <li>Recovery run: 61fdb79b-8012-4676-ac71-2971830e126a</li>
                          <li>Status before: in_progress</li>
                          <li>Normalized cause: Run completed without disposition</li>
                          <li>Recovery owner: CTO</li>
                          <li>Suggested action: Reassign to recovery agent</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <p className="px-1 text-xs text-muted-foreground">
              Author reads as <span className="font-medium text-foreground">You</span> even though the
              author is the Paperclip system. Two containers stack the warning inside a user-style
              bubble, and operational evidence is always visible.
            </p>
          </div>
        </LabSection>

        <LabSection
          eyebrow="After"
          title="System notice replacement"
          description="One container, system-authored label, hidden details. The chat surface keeps user and agent bubbles unchanged."
          accentClassName="bg-[linear-gradient(180deg,rgba(16,185,129,0.05),transparent_28%),var(--background)]"
        >
          <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4">
            <SystemNotice {...dangerCollapsed} />
            <p className="px-1 text-xs text-muted-foreground">
              Same content. The visible body is one short system sentence; reviewers expand{" "}
              <span className="font-medium text-foreground">Details</span> only when they need run
              evidence. Tone is reinforced by the octagon icon and the &quot;System alert&quot; label,
              not just red.
            </p>
          </div>
        </LabSection>
      </div>

      <Card className="gap-4 border-border/70 bg-background/85 py-0">
        <CardHeader className="px-5 pt-5 pb-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <Layers className="h-4 w-4 text-amber-700 dark:text-amber-300" />
            Implementation notes
          </div>
          <CardTitle className="text-lg">Handoff to engineering</CardTitle>
          <CardDescription>
            What the Phase 4 UI implementation should preserve from this design.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-5 pb-5 pt-0 text-sm text-muted-foreground">
          <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
            <div className="mb-1 font-medium text-foreground">Component</div>
            Use <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">{`<SystemNotice />`}</code>{" "}
            from <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">@/components/SystemNotice</code>.
            It accepts <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">tone</code>,{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">label</code>,{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">body</code>,{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">metadata</code>, and{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">detailsDefaultOpen</code>.
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
            <div className="mb-1 font-medium text-foreground">Routing in IssueChatThread</div>
            Comments where{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">authorType === &quot;system&quot;</code>{" "}
            or{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">presentation.kind === &quot;system_notice&quot;</code>{" "}
            should render as a SystemNotice row at full content width — never inside an{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">IssueChatUserMessage</code>{" "}
            or assistant bubble.
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
            <div className="mb-1 font-medium text-foreground">Accessibility</div>
            The Details button has{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">aria-expanded</code>{" "}
            and{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">aria-controls</code>{" "}
            wired to the panel id. The container exposes{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">role=&quot;status&quot;</code>{" "}
            and an{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">aria-label</code>{" "}
            equal to the visible tone label so screen readers announce tone with text.
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
            <div className="mb-1 font-medium text-foreground">Legacy fallback</div>
            Existing comments without{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">presentation</code>{" "}
            keep rendering through the current{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">SuccessfulRunHandoffCommentCallout</code>{" "}
            string-detector. The new contract is opt-in for the system generators in Phase 5.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default SystemNoticeUxLab;
