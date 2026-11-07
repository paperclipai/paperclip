import { t as translateShell, useTranslation, Trans } from "@/i18n";
// token-extraction: allowlisted — intentional one-off decoration (DECISION-SHEET.md B1
// user ruling). The bg-[...gradient...] / shadow-[...] literals in this demo/UX-lab page
// are deliberate one-off decoration, reverted from --gradient-extract-*/--shadow-extract-*
// tokens; the file is on the check-token-gates allowlist in ui/src/index.css.
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
  const { t: translateShell } = useTranslation("shell");
  return (
    <section
      id={id}
      className={cn(
        "rounded-(--rad-28) border border-border/70 bg-background/85 p-4 shadow-[0_24px_60px_rgba(15,23,42,0.08)] sm:p-5",
        accentClassName,
      )}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
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
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
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
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className={cn("flex items-start gap-2.5", alignEnd && "justify-end")}>
      {!alignEnd ? (
        <Avatar size="sm" className="shrink-0">
          <AvatarFallback>{authorName.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
      ) : null}
      <div className={cn("flex min-w-0 max-w-(--pct-85) flex-col", alignEnd && "items-end")}>
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
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="flex items-start gap-2.5">
      <Avatar size="sm" className="shrink-0">
        <AvatarFallback>{agentName.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 max-w-(--pct-85) flex-col">
        <div className="mb-1 px-1 text-sm font-medium text-foreground">{agentName}</div>
        <div className="min-w-0 max-w-full rounded-2xl border border-border/70 bg-background px-4 py-2.5 text-sm leading-6 text-foreground">
          {body}
        </div>
      </div>
    </div>
  );
}

const checklist = () => ([
  translateShell("shell:one_container_per_system_notice_no_nested"),
  translateShell("shell:tone_communicated_by_icon_label_never_color"),
  translateShell("shell:operational_evidence_hidden_behind_details_expanded_only"),
  translateShell("shell:issue_agent_and_run_metadata_render_as"),
  translateShell("shell:hierarchy_visibly_distinct_from_user_right_aligned"),
]);

export function SystemNoticeUxLab() {
  const { t: translateShell } = useTranslation("shell");
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
      <div className="overflow-hidden rounded-(--rad-32) border border-border/70 bg-[linear-gradient(135deg,rgba(245,158,11,0.10),transparent_28%),linear-gradient(180deg,rgba(8,145,178,0.08),transparent_44%),var(--background)] shadow-[0_30px_80px_rgba(15,23,42,0.10)]">
        <div className="grid gap-6 lg:grid-cols-(--gtc-39)">
          <div className="p-6 sm:p-7">
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/25 bg-amber-500/[0.08] px-3 py-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-amber-700 dark:text-amber-300">
              <FlaskConical className="h-3.5 w-3.5" />{translateShell("shell:system_notice_lab")}</div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">{translateShell("shell:first_class_system_notice_treatment")}</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">{translateShell("shell:replaces_the_current_pattern_where_a_paperclip")}</p>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">{translateShell("shell:pap_3525_plan")}</Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">{translateShell("shell:phase_1_ux")}</Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">{translateShell("shell:tones_warning_danger_neutral")}</Badge>
            </div>
          </div>

          <aside className="border-t border-border/60 bg-background/70 p-6 lg:border-l lg:border-t-0">
            <div className="mb-4 flex items-center gap-2 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
              <ListChecks className="h-4 w-4 text-amber-700 dark:text-amber-300" />{translateShell("shell:what_this_lab_proves")}</div>
            <div className="space-y-3">
              {checklist().map((line) => (
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
        eyebrow={translateShell("shell:extra_51_tone_matrix")}
        title={translateShell("shell:three_tones_two_states")}
        description={translateShell("shell:each_tone_pairs_a_unique_icon_and")}
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
        eyebrow={translateShell("shell:extra_50_hierarchy_in_thread")}
        title={translateShell("shell:distinct_from_user_and_agent_comments")}
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
            label={translateShell("shell:system_alert")}
            source={{ label: "Paperclip", href: "/PAP/agents" }}
            timestamp="2026-05-04T16:48:00.000Z"
            body="Paperclip could not resolve this issue's missing disposition automatically. The source assignment is unchanged and a board decision is required."
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
          eyebrow={translateShell("shell:extra_49_before")}
          title={translateShell("shell:today_s_nested_treatment")}
          description={translateShell("shell:the_same_content_rendered_through_the_existing")}
          accentClassName="bg-[linear-gradient(180deg,rgba(244,63,94,0.05),transparent_28%),var(--background)]"
        >
          <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4">
            <div className="flex items-start gap-2.5">
              <Avatar size="sm" className="shrink-0">
                <AvatarFallback>{"YO"}</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 max-w-(--pct-85) flex-col">
                <div className="mb-1 px-1 text-sm font-medium text-foreground">{translateShell("shell:you")}</div>
                <div className="min-w-0 max-w-full rounded-2xl bg-muted px-4 py-2.5 text-sm leading-6 text-foreground">
                  <div className="rounded-md border border-red-500/35 bg-red-500/10 px-3 py-2.5 text-sm text-red-950 dark:text-red-100">
                    <div className="flex items-start gap-2">
                      <Sparkles className="mt-1 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" />
                      <div className="min-w-0">
                        <p className="m-0 font-semibold">{translateShell("shell:successful_run_handoff_missing")}</p>
                        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-(length:--text-compact) leading-5">
                          <li>{translateShell("shell:source_issue_pap_3440")}</li>
                          <li>{translateShell("shell:source_run_9cdba892_c7ca_4d93_8604_4843873b127c")}</li>
                          <li>{translateShell("shell:recovery_run_61fdb79b_8012_4676_ac71_2971830e126a")}</li>
                          <li>{translateShell("shell:status_before_in_progress")}</li>
                          <li>{translateShell("shell:normalized_cause_run_completed_without_disposition")}</li>
                          <li>{translateShell("shell:recovery_owner_cto")}</li>
                          <li>{translateShell("shell:suggested_action_reassign_to_recovery_agent")}</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <p className="px-1 text-xs text-muted-foreground"><Trans ns="shell" i18nKey="author_reads_as_even_though_the_author" components={{ part1: <>{<span className="font-medium text-foreground">You</span>}</> }} /></p>
          </div>
        </LabSection>

        <LabSection
          eyebrow={translateShell("shell:extra_48_after")}
          title={translateShell("shell:system_notice_replacement")}
          description={translateShell("shell:one_container_system_authored_label_hidden_details")}
          accentClassName="bg-[linear-gradient(180deg,rgba(16,185,129,0.05),transparent_28%),var(--background)]"
        >
          <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4">
            <SystemNotice {...dangerCollapsed} />
            <p className="px-1 text-xs text-muted-foreground"><Trans ns="shell" i18nKey="same_content_the_visible_body_is_one" components={{ part1: <>{<span className="font-medium text-foreground">Details</span>}</> }} /></p>
          </div>
        </LabSection>
      </div>

      <Card className="gap-4 border-border/70 bg-background/85 py-0">
        <CardHeader className="px-5 pt-5 pb-0">
          <div className="flex items-center gap-2 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            <Layers className="h-4 w-4 text-amber-700 dark:text-amber-300" />{translateShell("shell:implementation_notes")}</div>
          <CardTitle className="text-lg">{translateShell("shell:handoff_to_engineering")}</CardTitle>
          <CardDescription>{translateShell("shell:what_the_phase_4_ui_implementation_should")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-5 pb-5 pt-0 text-sm text-muted-foreground">
          <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
            <div className="mb-1 font-medium text-foreground">{translateShell("shell:component")}</div>{translateShell("shell:use")}{" "}<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{`<SystemNotice />`}</code>{" "}{translateShell("shell:from")}{" "}<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">@/components/SystemNotice</code>{translateShell("shell:it_accepts")}{" "}<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">tone</code>,{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">label</code>,{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">body</code>,{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">metadata</code>{translateShell("shell:and")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">detailsDefaultOpen</code>.
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
            <div className="mb-1 font-medium text-foreground">{translateShell("shell:routing_in_issuechatthread")}</div>{translateShell("shell:comments_where")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">authorType === &quot;system&quot;</code>{" "}{translateShell("shell:or")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">presentation.kind === &quot;system_notice&quot;</code>{" "}{translateShell("shell:should_render_as_a_systemnotice_row_at")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">IssueChatUserMessage</code>{" "}{translateShell("shell:or_assistant_bubble")}</div>
          <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
            <div className="mb-1 font-medium text-foreground">{translateShell("shell:accessibility")}</div>{translateShell("shell:the_details_button_has")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">aria-expanded</code>{" "}{translateShell("shell:and_620111")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">aria-controls</code>{" "}{translateShell("shell:wired_to_the_panel_id_the_container")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">role=&quot;status&quot;</code>{" "}{translateShell("shell:and_an")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">aria-label</code>{" "}{translateShell("shell:equal_to_the_visible_tone_label_so")}</div>
          <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
            <div className="mb-1 font-medium text-foreground">{translateShell("shell:legacy_fallback")}</div>{translateShell("shell:existing_comments_without")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">presentation</code>{" "}{translateShell("shell:keep_rendering_through_the_current")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">SuccessfulRunHandoffCommentCallout</code>{" "}{translateShell("shell:string_detector_the_new_contract_is_opt")}</div>
        </CardContent>
      </Card>
    </div>
  );
}

export default SystemNoticeUxLab;
