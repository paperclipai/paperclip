import { t as finalPagesT } from "@/i18n";
import { t as translateShell, useTranslation } from "@/i18n";
import type { ReactNode } from "react";
import { ISSUE_WRITE_DENIAL_CODES } from "@paperclipai/shared";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { CommentAttributionChip } from "@/components/CommentAttributionChip";
import { IssueFieldChangeReceipt } from "@/components/IssueFieldChangeReceipt";
import { IssueWriteDenialNotice } from "@/components/IssueWriteDenialNotice";
import { Identity } from "@/components/Identity";
import { cn } from "@/lib/utils";

/**
 * UX lab for the three surfaces that make open
 * cross-issue collaboration legible — the "for {user}" attribution chip, the
 * field-edit audit receipt in the activity stream, and actionable denial copy.
 *
 * Route: /ux-lab/cross-issue-collaboration. Public (no session) so the states
 * can be captured for UX review without seeding a live thread.
 */

function LabSection({
  index,
  title,
  description,
  children,
  columns = 2,
}: {
  index: string;
  title: string;
  description: string;
  children: ReactNode;
  columns?: 1 | 2;
}) {
  const { t: translateShell } = useTranslation("shell");
  return (
    <section className="rounded-2xl border border-border/70 bg-background/85 p-5 shadow-sm">
      <div className="mb-4">
        <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
          {index}
        </div>
        <h2 className="mt-1 text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className={cn("grid gap-4", columns === 2 && "lg:grid-cols-2")}>{children}</div>
    </section>
  );
}

function Frame({ label, children }: { label: string; children: ReactNode }) {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="space-y-2">
      <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
        {label}
      </div>
      <Card className="block border-border/60 p-3">{children}</Card>
    </div>
  );
}

/** A faithful copy of an agent comment bubble header + body (IssueChatThread.tsx). */
function AgentCommentBubble({
  authorName,
  onBehalfOf,
  body,
}: {
  authorName: string;
  onBehalfOf?: string | null;
  body: string;
}) {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="flex flex-col items-start py-1.5">
      <div className="mb-1 flex items-center gap-1.5 px-1">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          <Avatar size="sm" className="size-5">
            <AvatarFallback className="text-(length:--text-nano)">
              {authorName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </span>
        <span className="text-sm font-medium text-foreground">{authorName}</span>
        {onBehalfOf ? (
          <CommentAttributionChip agentName={authorName} userName={onBehalfOf} />
        ) : null}
      </div>
      <div className="min-w-0 max-w-(--pct-85) break-words border border-border bg-card px-3 py-2 text-sm text-foreground [border-radius:14px_14px_14px_4px]">
        {body}
      </div>
    </div>
  );
}

/** A faithful copy of an activity row in the issue run ledger (IssueDetail.tsx). */
function ActivityRow({
  actorName,
  verb,
  children,
}: {
  actorName: string;
  verb: string;
  children?: ReactNode;
}) {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <Identity name={actorName} size="sm" />
        <span>{verb}</span>
        <span className="ml-auto shrink-0">{translateShell("shell:2m_ago")}</span>
      </div>
      {children}
    </div>
  );
}

const AGENT_NAMES = new Map([
  ["3108ef8e-5ed0-41d9-b561-6b41c41b8545", "ClaudeCoder"],
  ["6670e11b-91d3-4429-82e0-436b88b51808", "UXDesigner"],
]);

export function CrossIssueCollaborationUxLab() {
  const { t: translateShell } = useTranslation("shell");
  const resolveAgentLabel = (id: string) => AGENT_NAMES.get(id) ?? null;
  const resolveUserLabel = (id: string) => (id === "user-dotta" ? "Dotta" : null);

  return (
    <div className="min-h-screen bg-muted/20 p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">{translateShell("shell:open_cross_task_collaboration")}</div>
          <h1 className="mt-1 text-xl font-semibold text-foreground">{translateShell("shell:open_cross_task_collaboration_attribution_audit_and")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{translateShell("shell:agents_may_now_write_to_any_task")}</p>
        </header>

        <LabSection
          index={translateShell("shell:extra_11_1_attribution_chip_plan_3a_")}
          title={translateShell("shell:fable_for_dotta_on_a_cross_task")}
          description={translateShell("shell:an_agent_commenting_on_a_task_it")}
        >
          <Frame label={translateShell("shell:assignee_s_own_comment_no_chip")}>
            <AgentCommentBubble
              authorName="CodexCoder"
              body="Rebased onto master and re-ran the containment suite; all green."
            />
          </Frame>
          <Frame label={translateShell("shell:cross_task_comment_chipped")}>
            <AgentCommentBubble
              authorName="Fable"
              onBehalfOf="Dotta"
              body="Dotta asked me to flag that the retry window here overlaps TASK-482. Worth a look before you close this."
            />
          </Frame>
          <Frame label={translateShell("shell:responsible_user_not_in_the_loaded_directory")}>
            <AgentCommentBubble
              authorName="Fable"
              onBehalfOf={finalPagesT("final-pages:the_responsible_user_bed14d")}
              body={finalPagesT("final-pages:Falls_back_to_a_generic_label_rather_than_printing_a_raw_user_id_c74ad2")}
            />
          </Frame>
          <Frame label={translateShell("shell:long_user_name_truncates_in_the_chip")}>
            <AgentCommentBubble
              authorName="Fable"
              onBehalfOf="Alexandra Konstantinopoulos-Whitfield"
              body={finalPagesT("final-pages:The_chip_caps_its_width_and_truncates_the_tooltip_carries_the_ful_83b2dc")}
            />
          </Frame>
        </LabSection>

        <LabSection
          index={translateShell("shell:extra_10_2_field_edit_audit_receipt_plan_3b_")}
          title={translateShell("shell:every_patch_says_who_changed_what_and")}
          description={translateShell("shell:required_for_agent_and_board_edits_alike")}
        >
          <Frame label={translateShell("shell:cross_task_agent_edit")}>
            <ActivityRow actorName="Fable" verb={finalPagesT("final-pages:changed_the_status_from_todo_to_in_progress_0fa623")}>
              <IssueFieldChangeReceipt
                event={{
                  action: "issue.updated",
                  responsibleUserId: "user-dotta",
                  details: {
                    authorizationReason: "allow_visible_issue_write",
                    changes: {
                      status: { from: "todo", to: "in_progress" },
                      priority: { from: "medium", to: "high" },
                    },
                  },
                }}
                resolveAgentLabel={resolveAgentLabel}
                resolveUserLabel={resolveUserLabel}
              />
            </ActivityRow>
          </Frame>
          <Frame label={translateShell("shell:board_human_edit_audited_the_same_way")}>
            <ActivityRow actorName="Dotta" verb={finalPagesT("final-pages:updated_the_issue_ad4620")}>
              <IssueFieldChangeReceipt
                event={{
                  action: "issue.updated",
                  responsibleUserId: "user-dotta",
                  details: {
                    authorizationReason: "allow_board_actor",
                    changes: {
                      assigneeAgentId: {
                        from: "3108ef8e-5ed0-41d9-b561-6b41c41b8545",
                        to: "6670e11b-91d3-4429-82e0-436b88b51808",
                      },
                      description: { from: "Old brief…", to: "New brief…", updated: true },
                    },
                  },
                }}
                resolveAgentLabel={resolveAgentLabel}
                resolveUserLabel={resolveUserLabel}
              />
            </ActivityRow>
          </Frame>
          <Frame label={translateShell("shell:reassignment_blockers_and_work_mode_in_one")}>
            <ActivityRow actorName="CTO" verb={finalPagesT("final-pages:updated_the_issue_ad4620")}>
              <IssueFieldChangeReceipt
                event={{
                  action: "issue.updated",
                  responsibleUserId: "user-dotta",
                  details: {
                    authorizationReason: "allow_visible_issue_write",
                    changes: {
                      blockedByIssueIds: { from: [], to: ["TASK-491", "TASK-492"] },
                      workMode: { from: "planning", to: "standard" },
                      assigneeAgentId: {
                        from: null,
                        to: "3108ef8e-5ed0-41d9-b561-6b41c41b8545",
                      },
                    },
                  },
                }}
                resolveAgentLabel={resolveAgentLabel}
                resolveUserLabel={resolveUserLabel}
              />
            </ActivityRow>
          </Frame>
          <Frame label={translateShell("shell:older_activity_row_no_receipt_renders_unchanged")}>
            <ActivityRow actorName="CodexCoder" verb={finalPagesT("final-pages:checked_out_the_issue_6716c0")} />
          </Frame>
        </LabSection>

        <LabSection
          index={translateShell("shell:extra_9_3_actionable_denial_copy_plan_6_")}
          title={translateShell("shell:every_wall_names_the_boundary_who_can")}
          description={translateShell("shell:a_real_incident_burned_a_full_detour")}
          columns={1}
        >
          <Frame label={translateShell("shell:before_what_the_incident_actually_saw")}>
            <div className="text-xs">
              <span className="text-red-600 dark:text-red-400">
                403 Forbidden: Issue is outside this actor&apos;s authorization boundary
              </span>
              <p className="mt-1 text-muted-foreground">{translateShell("shell:no_boundary_named_nobody_named_no_path")}</p>
            </div>
          </Frame>
          {ISSUE_WRITE_DENIAL_CODES.map((code) => (
            <Frame key={code} label={translateShell("shell:after", { value1: code })}>
              <IssueWriteDenialNotice
                code={code}
                context={{
                  actorLabel: "Fable",
                  assigneeLabel: "CodexCoder",
                  responsibleUserName: "Dotta",
                  issueIdentifier: "TASK-482",
                  cap: 20,
                  count: 21,
                }}
              />
            </Frame>
          ))}
        </LabSection>
      </div>
    </div>
  );
}

export default CrossIssueCollaborationUxLab;
