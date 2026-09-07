import { t, i18n } from "@/i18n";

// Built-in copy only. Raw registries and group keys remain stable for sorting,
// keyboard selection, storage, and API requests; user-authored titles stay raw.
const ATTENTION_DISPLAY_KEYS: Readonly<Record<string, string>> = {
  "Attention items whose issue has a pull_request work product.": "localizationAttention.ui_Attention_items_whose_issue_has_a_pull_request_work_product_9m69he",
  "Pending request_confirmation interactions bound to the issue's plan document.": "localizationAttention.ui_Pending_request_confirmation_interactions_bound_to_the_issue_s_pl_v2dot7",
  "Pending ask_user_questions interactions.": "localizationAttention.ui_Pending_ask_user_questions_interactions_58spge",
  "1 hour": "localizationAttention.ui_1_hour_3eima2",
  "4 hours": "localizationAttention.ui_4_hours_sznyog",
  "Tomorrow morning": "localizationAttention.ui_Tomorrow_morning_1ohqmm2",
  "Tomorrow": "localizationAttention.ui_Tomorrow_lgiq12",
  "Next week": "localizationAttention.ui_Next_week_21mopg",
  "Collapse decision": "localizationAttention.ui_Collapse_decision_1q5wpvk",
  "Expand decision": "localizationAttention.ui_Expand_decision_hspu1",
  "See less": "localizationAttention.ui_See_less_gwajrd",
  "See more": "localizationAttention.ui_See_more_1dgp2j5",
  "Open": "localizationAttention.ui_Open_n6hn1l",
  "Restore": "localizationAttention.ui_Restore_4fiyr5",
  "Row actions": "localizationAttention.ui_Row_actions_1p4jgww",
  "Dismiss": "localizationAttention.ui_Dismiss_an1pf7",
  "Open source": "localizationAttention.ui_Open_source_18gxi32",
  "Decision actions": "localizationAttention.ui_Decision_actions_19txe2g",
  "View issue": "localizationAttention.ui_View_issue_ll8pr7",
  "Snooze": "localizationAttention.ui_Snooze_1k71mcf",
  "Custom": "localizationAttention.ui_Custom_15dsham",
  "Snooze until…": "localizationAttention.ui_Snooze_until_1q0vugz",
  "Missing issue reference for this decision.": "localizationAttention.ui_Missing_issue_reference_for_this_decision_j06bre",
  "This decision must be completed from its detail view.": "localizationAttention.ui_This_decision_must_be_completed_from_its_detail_view_1tl4i4",
  "Optional decision note…": "localizationAttention.ui_Optional_decision_note_1aifkgv",
  "Request revision": "localizationAttention.ui_Request_revision_122e0tr",
  "Reject": "localizationAttention.ui_Reject_1kej36u",
  "Approve": "localizationAttention.ui_Approve_1s2ov2y",
  "Accept": "localizationAttention.ui_Accept_me22x5",
  "Decline": "localizationAttention.ui_Decline_oo69tl",
  "Options that require an unchanged target are disabled below.": "localizationAttention.ui_Options_that_require_an_unchanged_target_are_disabled_below_1dmyxy1",
  "Blocked · stale": "localizationAttention.ui_Blocked_stale_1096tuj",
  "This cancels an entire issue tree": "localizationAttention.ui_This_cancels_an_entire_issue_tree_1n37vzn",
  "This issue and every sub-issue beneath it will be cancelled.": "localizationAttention.ui_This_issue_and_every_sub_issue_beneath_it_will_be_cancelled_ee7nwc",
  "Type the issue identifier to confirm": "localizationAttention.ui_Type_the_issue_identifier_to_confirm_1agol6p",
  "Cancel": "localizationAttention.ui_Cancel_ew9em3",
  "Cancel tree": "localizationAttention.ui_Cancel_tree_1855b7d",
  "Not now?": "localizationAttention.ui_Not_now_15jgv37",
  "Dismiss — no effects": "localizationAttention.ui_Dismiss_no_effects_1rxnewg",
  "The decision window closed": "localizationAttention.ui_The_decision_window_closed_1uvsdhe",
  "A target issue was cancelled before this was decided.": "localizationAttention.ui_A_target_issue_was_cancelled_before_this_was_decided_1ppwusu",
  "All target issues were completed before this was decided.": "localizationAttention.ui_All_target_issues_were_completed_before_this_was_decided_1c2m01",
  "No response before the expiry deadline.": "localizationAttention.ui_No_response_before_the_expiry_deadline_ktjsos",
  "The proposer was re-woken.": "localizationAttention.ui_The_proposer_was_re_woken_1r37fcn",
  "This decision was withdrawn by the proposer before a response.": "localizationAttention.ui_This_decision_was_withdrawn_by_the_proposer_before_a_response_4h4apd",
  "Dismissed — no effects were run.": "localizationAttention.ui_Dismissed_no_effects_were_run_1odou9h",
  "Some effects may already have been applied. Review the results before asking the proposer to re-propose.": "localizationAttention.ui_Some_effects_may_already_have_been_applied_Review_the_results_bef_1vmqx9g",
  "Filter": "localizationAttention.ui_Filter_1vvvdef",
  "Group": "localizationAttention.ui_Group_1ihp9o",
  "Sort": "localizationAttention.ui_Sort_10q0c8h",
  "Clear": "localizationAttention.ui_Clear_1aeugy",
  "Type": "localizationAttention.ui_Type_1m2zofh",
  "Severity": "localizationAttention.ui_Severity_v7rniq",
  "Project": "localizationAttention.ui_Project_y8csbi",
  "No project": "localizationAttention.ui_No_project_d4oyzz",
  "Workspace": "localizationAttention.ui_Workspace_aw4cba",
  "No workspace": "localizationAttention.ui_No_workspace_xqgu2n",
  "When to decide": "localizationAttention.ui_When_to_decide_x3itni",
  "Pick date": "localizationAttention.ui_Pick_date_9qapa4",
  "Queues": "localizationAttention.ui_Queues_1371eb5",
  "No linked task to ask about": "localizationAttention.ui_No_linked_task_to_ask_about_17za1ul",
  "Could not create queue": "localizationAttention.ui_Could_not_create_queue_1t00ob2",
  "Queue": "localizationAttention.ui_Queue_16wbfbs",
  "New queue name…": "localizationAttention.ui_New_queue_name_1s92cih",
  "Create": "localizationAttention.ui_Create_16gte2l",
  "No other queues yet.": "localizationAttention.ui_No_other_queues_yet_ka49ms",
  "New queue…": "localizationAttention.ui_New_queue_1eo84cs",
  "Ask agent for recommendation": "localizationAttention.ui_Ask_agent_for_recommendation_1cus65r",
  "Please try again.": "localizationAttention.ui_Please_try_again_w91vc0",
  "This decision has no linked task to route from.": "localizationAttention.ui_This_decision_has_no_linked_task_to_route_from_hlt0l8",
  "Approval": "localizationAttention.ui_Approval_17ztw7a",
  "Decision": "localizationAttention.ui_Decision_1gvmqkj",
  "Decision requested": "localizationAttention.ui_Decision_requested_mnim7",
  "Join request": "localizationAttention.ui_Join_request_1wxkjdw",
  "Recovery": "localizationAttention.ui_Recovery_bx9hye",
  "Productivity review": "localizationAttention.ui_Productivity_review_1r8mfpb",
  "Blocked dependency": "localizationAttention.ui_Blocked_dependency_1w9irog",
  "Review": "localizationAttention.ui_Review_tnr3lt",
  "Failed run": "localizationAttention.ui_Failed_run_1tnwnyx",
  "Budget": "localizationAttention.ui_Budget_auevmw",
  "Agent error": "localizationAttention.ui_Agent_error_kavbo4",
  "Critical": "localizationAttention.ui_Critical_11om8bs",
  "High": "localizationAttention.ui_High_1gq8xlp",
  "Medium": "localizationAttention.ui_Medium_2pbr86",
  "Low": "localizationAttention.ui_Low_1dcndpd",
  "Decide now": "localizationAttention.ui_Decide_now_rgmzzx",
  "New today": "localizationAttention.ui_New_today_157jk1o",
  "Earlier": "localizationAttention.ui_Earlier_1ioa20r",
  "Not set": "localizationAttention.ui_Not_set_1ntesau",
  "Today": "localizationAttention.ui_Today_1sawk0u",
  "This week": "localizationAttention.ui_This_week_1nvt7jn",
  "Whenever": "localizationAttention.ui_Whenever_1dy6wc1",
  "All": "localizationAttention.ui_All_wnjk2s",
  "Yesterday": "localizationAttention.ui_Yesterday_14z5arr",
  "Last 7 days": "localizationAttention.ui_Last_7_days_ewnjbj",
  "This month": "localizationAttention.ui_This_month_1quvzxz",
  "None": "localizationAttention.ui_None_deku7v",
  "Date": "localizationAttention.ui_Date_ggjuyh",
  "Newest first": "localizationAttention.ui_Newest_first_1nodtc5",
  "Oldest first": "localizationAttention.ui_Oldest_first_1rto5ps",
  "unknown": "localizationAttention.ui_unknown_174uabd",
  "Apply effect": "localizationAttention.ui_Apply_effect_1twkct4",
  "blocked by the permission boundary (fail-closed)": "localizationAttention.ui_blocked_by_the_permission_boundary_fail_closed_1bk176q",
  "a referenced issue no longer exists": "localizationAttention.ui_a_referenced_issue_no_longer_exists_1rko4jc",
  "the target changed since this was proposed": "localizationAttention.ui_the_target_changed_since_this_was_proposed_3ur12m",
  "the effect errored while running": "localizationAttention.ui_the_effect_errored_while_running_18qq5sc",
  "the effect could not run": "localizationAttention.ui_the_effect_could_not_run_tlpjeo",
  "a new issue": "localizationAttention.ui_a_new_issue_1o9zm2l",
  "Pending": "localizationAttention.ui_Pending_e8nfto",
  "Expired": "localizationAttention.ui_Expired_1gcie36",
  "Cancelled": "localizationAttention.ui_Cancelled_1a3t1vg",
  "Dismissed": "localizationAttention.ui_Dismissed_1htslyq",
  "Decided": "localizationAttention.ui_Decided_16psugv",
  "Partial": "localizationAttention.ui_Partial_xcezp6",
  "Failed": "localizationAttention.ui_Failed_npsixg",
  "Destructive": "localizationAttention.ui_Destructive_c80sdf",
  "view run": "localizationAttention.ui_view_run_9qu9ct",
  "changed": "localizationAttention.ui_changed_jgug0r",
};

/** Only translate unchanged, system-created seed copy. Custom queue names and
 * descriptions are user content, even when their text resembles a built-in. */
export function decisionQueueTitleDisplay(queue: { key: string; title: string; createdByType?: string }): string {
  const defaults: Record<string, [string, string]> = { prs: ["PRs", "queuePrs"], plans: ["Plans", "queuePlans"], questions: ["Questions", "queueQuestions"] };
  const preset = defaults[queue.key];
  return queue.createdByType === "system" && preset && queue.title === preset[0] ? t(`localizationAttention.${preset[1]}`) : queue.title;
}

export function decisionQueueDescriptionDisplay(queue: { key: string; description: string | null; createdByType?: string }): string | null {
  const defaults: Record<string, [string, string]> = { prs: ["Pull-request and merge decisions detected from issue work products.", "queuePrsDescription"], plans: ["Plan revisions waiting for confirmation.", "queuePlansDescription"], questions: ["Structured questions waiting for a board response.", "queueQuestionsDescription"] };
  const preset = defaults[queue.key];
  return queue.createdByType === "system" && preset && queue.description === preset[0] ? t(`localizationAttention.${preset[1]}`) : queue.description;
}

export function attentionLabel(value: string): string {
  const key = ATTENTION_DISPLAY_KEYS[value];
  return key ? t(key) : value;
}

export function attentionGroupLabelDisplay(group: AttentionGroup): string | null {
  if (group.label === null) return null;
  if (group.key.startsWith("project:") && group.key !== `project:${NO_GROUP_SENTINEL}`) return group.label;
  return attentionLabel(group.label);
}

export function decideByLabelDisplay(decideBy: string | null): string {
  if (decideBy && /^\d{4}-\d{2}-\d{2}$/.test(decideBy)) {
    const parsed = new Date(`${decideBy}T00:00:00.000Z`);
    if (Number.isFinite(parsed.getTime())) return parsed.toLocaleDateString(i18n.resolvedLanguage, { month: "short", day: "numeric", timeZone: "UTC" });
  }
  return attentionLabel(decideByLabel(decideBy));
}


import type {
  AttentionDetailImage,
  AttentionFeed,
  AttentionFeedQuery,
  AttentionItem,
  AttentionItemDetail,
  AttentionProjectRef,
  AttentionSeverity,
  AttentionSourceKind,
  AttentionWorkspaceRef,
} from "@paperclipai/shared";

export type AttentionListOptions = AttentionFeedQuery;

/**
 * Source kinds the queue can fully resolve in-row. Everything else deep-links
 * to its native surface — the state-derived sources (recovery, failures,
 * budget) expose verbs too rich to safely inline here, so they open their
 * surface.
 *
 * `review` is inline *only when stalled* (PAP-16080 §4.4): a stalled review has
 * no interaction/approval/monitor to open, so the three review verbs
 * (approve / request changes / send back) actuate in-row — the server flips
 * `inlineResolvable` on for exactly those rows (`isInlineResolvable` still ANDs
 * that flag). A *covered* review keeps deep-linking, since its real action
 * lives on the issue (the pending card, a monitor, a live run).
 */
export const INLINE_RESOLVABLE_SOURCE_KINDS: ReadonlySet<AttentionSourceKind> = new Set<AttentionSourceKind>([
  "approval",
  "decision",
  "issue_thread_interaction",
  "join_request",
  "review",
]);

export function isInlineResolvable(item: AttentionItem): boolean {
  return item.inlineResolvable && INLINE_RESOLVABLE_SOURCE_KINDS.has(item.sourceKind);
}

/**
 * Per-source wording only. The icon used to live here too — one glyph per
 * source kind — but rows now borrow the task-status glyph for their kind (see
 * `attentionStatus` below), so a source contributes its *name* and nothing
 * visual.
 */
interface SourceMeta {
  label: string;
}

const SOURCE_META: Record<AttentionSourceKind, SourceMeta> = {
  approval: { label: "Approval" },
  decision: { label: "Decision" },
  issue_thread_interaction: { label: "Decision requested" },
  join_request: { label: "Join request" },
  recovery_action: { label: "Recovery" },
  productivity_review: { label: "Productivity review" },
  blocker_attention: { label: "Blocked dependency" },
  review: { label: "Review" },
  failed_run: { label: "Failed run" },
  budget_alert: { label: "Budget" },
  agent_error_alert: { label: "Agent error" },
};

export function sourceMeta(kind: AttentionSourceKind): SourceMeta {
  return SOURCE_META[kind] ?? { label: kind.replaceAll("_", " ") };
}

interface SeverityStyle {
  /** Left accent bar + dot color. */
  accent: string;
  dot: string;
  label: string;
}

const SEVERITY_STYLE: Record<AttentionSeverity, SeverityStyle> = {
  critical: { accent: "bg-red-500", dot: "bg-red-500", label: "Critical" },
  high: { accent: "bg-orange-500", dot: "bg-orange-500", label: "High" },
  medium: { accent: "bg-yellow-500", dot: "bg-yellow-500", label: "Medium" },
  low: { accent: "bg-blue-500", dot: "bg-blue-500", label: "Low" },
};

export function severityStyle(severity: AttentionSeverity): SeverityStyle {
  return SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.low;
}

// ---------------------------------------------------------------------------
// Decision kind → borrowed task status (supersedes the PAP-13409 §4 tone map)
//
// The queue used to run five parallel colour/icon vocabularies (sky / violet /
// rose / amber / neutral), one glyph per source kind, plus an orange-or-red
// severity badge — so two rows demanding the same response from an operator
// could look completely unrelated. The system is flattened to TWO kinds, and
// each one *borrows the task status it corresponds to* instead of declaring a
// palette of its own:
//
//   • blocking — failed run, agent error, blocked dependency, recovery, budget
//       → task status `blocked`    (red, CircleMinus)
//   • review   — approval, confirmation, review, join request, everything else
//       → task status `in_review`  (violet, CircleDot)
//
// Colour and glyph therefore resolve through <StatusGlyph> and the
// `--status-task-icon-*` tokens, so the decision queue and the task list stay
// in lockstep by construction — an operator learns the vocabulary once
// (DESIGN.md principle 5). Source kinds keep their own *wording* ("Approval",
// "Agent error", …); only colour and icon merge.
//
// Severity is no longer chrome. It survives as a filter/group dimension in the
// toolbar, which is where an operator goes when they want to rank by urgency.
// ---------------------------------------------------------------------------

export type AttentionKind = "blocking" | "review";

/** The task status each decision kind renders as. */
export const ATTENTION_KIND_STATUS: Record<AttentionKind, "blocked" | "in_review"> = {
  blocking: "blocked",
  review: "in_review",
};

/** Does this row report something stuck, or something waiting on a verdict? */
export function attentionKind(item: AttentionItem): AttentionKind {
  switch (item.sourceKind) {
    case "decision":
      return "review";
    case "failed_run":
    case "agent_error_alert":
    case "blocker_attention":
    case "recovery_action":
    case "budget_alert":
      return "blocking";
    case "approval":
    case "issue_thread_interaction":
    case "join_request":
    case "review":
    case "productivity_review":
    default:
      return "review";
  }
}

/** Task status a row borrows its glyph and colour from — feeds <StatusGlyph>. */
export function attentionStatus(item: AttentionItem): "blocked" | "in_review" {
  return ATTENTION_KIND_STATUS[attentionKind(item)];
}

/**
 * The task a row belongs to, wherever the feed happens to put it.
 *
 * The feed uses two shapes, and a row that reads only one of them silently
 * drops the task key on the other:
 *   • the subject IS the task (review, blocked dependency) → `subject`
 *     carries the identifier and `relatedIssue` is null;
 *   • the subject hangs off a task (a thread interaction, an issue-scoped
 *     approval) → the task arrives separately as `relatedIssue`.
 *
 * `relatedIssue` wins when both are present: it is the *other* record, so it
 * is the one the subject alone can't tell you about.
 *
 * Returns null for rows genuinely not attached to a task — a hire approval, an
 * agent error — which should show no key rather than a borrowed one.
 *
 * Known gap (server-side, not resolvable here): an approval can carry
 * `subject.metadata.issueId` while `relatedIssue` is null. That is a bare UUID
 * with no key or href, so there is nothing to render; the feed builder has to
 * populate `relatedIssue` for those.
 */
export function attentionTaskRef(item: AttentionItem): { identifier: string; href: string | null } | null {
  const related = item.relatedIssue;
  if (related?.identifier) {
    return { identifier: related.identifier, href: related.href };
  }
  const subject = item.subject;
  if (subject.kind === "issue" && subject.identifier) {
    return { identifier: subject.identifier, href: subject.href };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Richer detail line (PAP-13409 §7) — render T1's structured `detail` block into
// a single secondary line under the title (the caller clamps it to 2 lines).
// ---------------------------------------------------------------------------

function quote(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return `“${trimmed}”`;
}

function countNoun(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

/**
 * A concise human-readable detail line for a row, e.g.
 *   "2 questions — “Which auth provider…”"
 *   "Deploy failed — “exit code 1 on migrate”".
 * Returns `null` when the detail carries nothing beyond the title, so the row
 * can fall back to `whyNow`.
 */
export function attentionDetailLine(item: AttentionItem): string | null {
  const detail = item.detail;
  if (!detail) return null;
  switch (detail.kind) {
    case "plan_approval":
      return detail.planTitle?.trim() || quote(detail.summaryExcerpt);
    case "approval":
      return quote(detail.summaryExcerpt);
    case "confirmation":
      return quote(detail.promptExcerpt);
    case "checkbox_confirmation": {
      const q = quote(detail.promptExcerpt);
      return q ? `${countNoun(detail.optionCount, "option")} — ${q}` : countNoun(detail.optionCount, "option");
    }
    case "questions": {
      const q = quote(detail.firstQuestionText);
      const label = countNoun(detail.questionCount, "question");
      return q ? `${label} — ${q}` : label;
    }
    case "suggested_tasks": {
      const q = quote(detail.firstTaskTitle);
      const label = countNoun(detail.taskCount, "suggested task");
      return q ? `${label} — ${q}` : label;
    }
    case "item_verdicts": {
      const q = quote(detail.promptExcerpt);
      const label = `${countNoun(detail.itemCount, "item")} to verdict`;
      return q ? `${label} — ${q}` : label;
    }
    case "failed_run":
    case "agent_error": {
      const reason = quote(detail.failureReasonExcerpt);
      if (detail.agentName && reason) return `${detail.agentName} — ${reason}`;
      return detail.agentName ?? reason;
    }
    case "blocker": {
      const b = detail.blockingIssue;
      if (!b) return null;
      const id = b.identifier ? `${b.identifier} ` : "";
      return b.title ? `Blocked by ${id}${b.title}` : b.identifier ? `Blocked by ${b.identifier}` : null;
    }
    case "budget":
      return `${Math.round(detail.observedPercent)}% of budget used ($${detail.amountObserved} / $${detail.amountLimit})`;
    case "generic":
      return quote(detail.summaryExcerpt);
    default:
      return null;
  }
}

/** Screenshot / thumbnail images attached to the detail block, if any. */
/** Display projection of generated detail copy. Source excerpts and identifiers
 * are passed through verbatim, and the raw helper remains available to callers. */
export function attentionDetailLineDisplay(item: AttentionItem): string | null {
  const detail = item.detail;
  if (!detail) return null;
  const quoted = (value: string | null | undefined) => {
    const raw = value?.trim();
    return raw ? (i18n.resolvedLanguage?.startsWith("ru") ? `«${raw}»` : `“${raw}”`) : null;
  };
  let label: string | null = null;
  let excerpt: string | null = null;
  switch (detail.kind) {
    case "checkbox_confirmation": label = t("localizationAttention.detailOptions", { count: detail.optionCount }); excerpt = quoted(detail.promptExcerpt); break;
    case "questions": label = t("localizationAttention.detailQuestions", { count: detail.questionCount }); excerpt = quoted(detail.firstQuestionText); break;
    case "suggested_tasks": label = t("localizationAttention.detailTasks", { count: detail.taskCount }); excerpt = quoted(detail.firstTaskTitle); break;
    case "item_verdicts": label = t("localizationAttention.detailVerdicts", { count: detail.itemCount }); excerpt = quoted(detail.promptExcerpt); break;
    case "blocker": {
      const blocker = detail.blockingIssue;
      if (!blocker) return null;
      const issue = [blocker.identifier, blocker.title].filter(Boolean).join(" ");
      return issue ? t("localizationAttention.detailBlockedBy", { issue }) : null;
    }
    case "budget": {
      const number = (value: number | string) => i18n.resolvedLanguage?.startsWith("ru") ? Number(value).toLocaleString(i18n.resolvedLanguage) : String(value);
      return t("localizationAttention.detailBudget", { percent: number(Math.round(detail.observedPercent)), observed: number(detail.amountObserved), limit: number(detail.amountLimit) });
    }
    default: return attentionDetailLine(item);
  }
  return excerpt ? `${label} — ${excerpt}` : label;
}

export function attentionDetailImages(item: AttentionItem): AttentionDetailImage[] {
  return (item.detail as AttentionItemDetail | null)?.images ?? [];
}

/**
 * Content URL for an attention detail image asset. Already-absolute or data
 * URLs pass through unchanged (server may hand back a CDN URL; stories use data
 * URIs), otherwise we resolve the in-app asset content route.
 */
export function attentionImageUrl(assetId: string): string {
  if (assetId.startsWith("data:") || assetId.startsWith("http")) return assetId;
  return `/api/assets/${assetId}/content`;
}

/**
 * The sidebar badge: distinct items that either surfaced today or carry an
 * explicit decide-by deadline that is due today/past. The server computes this
 * before pagination (`deskBadgeCount`), so badge polling can fetch a small
 * first page without losing the company-wide signal.
 */
export function attentionBadgeCount(feed: AttentionFeed | null | undefined): number {
  return feed?.deskBadgeCount ?? 0;
}

// ---------------------------------------------------------------------------
// Today's desk
//
// The default ungrouped desk reflects *what came up*, not a judgement about
// what "can wait". It builds up to three shelves in order:
//   • "Decide now" — only when an item has an explicit decide-by deadline that
//     is due today/past. No deadline set anywhere → no shelf, no claim.
//   • "New today"   — decisions that surfaced today (arrival grouping).
//   • "Earlier"     — everything else, older arrivals.
// The server owns the authoritative decide-by ranking (`sort=decide`) and the
// badge (`deskBadgeCount`); these client helpers mirror that logic *exactly*
// (same UTC day boundaries) so the on-page split and the badge never disagree.
// Keep in lockstep with `server/src/services/attention.ts`
// (`decideOrder`/`isDecideNow`/`isNewToday`).
// ---------------------------------------------------------------------------

const MS_PER_DAY_DECIDE = 24 * 60 * 60 * 1_000;

function startOfUtcDay(now: number): number {
  const value = new Date(now);
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function endOfUtcDay(now: number): number {
  return startOfUtcDay(now) + MS_PER_DAY_DECIDE - 1;
}

function endOfUtcWeek(now: number): number {
  const start = startOfUtcDay(now);
  const weekday = new Date(start).getUTCDay();
  const daysUntilSunday = weekday === 0 ? 0 : 7 - weekday;
  return start + (daysUntilSunday + 1) * MS_PER_DAY_DECIDE - 1;
}

/** [bucket, deadline] — lower bucket / earlier deadline sorts first. */
export function attentionDecideOrder(item: AttentionItem, now: number): [number, number] {
  if (item.decideBy === "today") return [0, endOfUtcDay(now)];
  if (item.decideBy === "this_week") return [0, endOfUtcWeek(now)];
  if (item.decideBy && /^\d{4}-\d{2}-\d{2}$/.test(item.decideBy)) {
    const deadline = Date.parse(`${item.decideBy}T23:59:59.999Z`);
    if (Number.isFinite(deadline)) return [0, deadline];
  }
  if (item.decideBy === "whenever") return [1, Number.MAX_SAFE_INTEGER];
  return [2, Number.MAX_SAFE_INTEGER];
}

/** Due today or overdue — the "Decide now" shelf. Only fires when `decideBy` is set. */
export function attentionIsDecideNow(item: AttentionItem, now: number): boolean {
  const [bucket, deadline] = attentionDecideOrder(item, now);
  return bucket === 0 && deadline <= endOfUtcDay(now);
}

/** Surfaced today (arrival) — the "New today" desk group. Uses UTC day, matching the badge. */
export function attentionIsNewToday(item: AttentionItem, now: number): boolean {
  const ts = new Date(item.createdAt).getTime();
  return Number.isFinite(ts) && ts >= startOfUtcDay(now);
}

/** A rendered desk shelf: shares the shape of {@link AttentionGroup}. */
export interface DeskShelf {
  key: string;
  label: string;
  items: AttentionItem[];
}

/**
 * Build the default (ungrouped) desk layout — the arrival-based grouping that
 * replaced the "Decide now" / "Can wait" split:
 *
 *   • "Decide now" — items with an explicit decide-by deadline due today/past,
 *     ordered by deadline. Omitted entirely when nothing has a due deadline, so
 *     the desk never leads with a shelf built on unset metadata.
 *   • "New today"  — remaining items that surfaced today, newest arrival first.
 *   • "Earlier"    — remaining older arrivals, newest arrival first.
 *
 * A decide-now item is only ever on the "Decide now" shelf, so the three shelves
 * are disjoint and their sizes sum to `items.length`.
 */
export function buildDeskShelves(items: AttentionItem[], now: number): DeskShelf[] {
  const decideNow = items
    .filter((item) => attentionIsDecideNow(item, now))
    .sort((a, b) => {
      const [, aDeadline] = attentionDecideOrder(a, now);
      const [, bDeadline] = attentionDecideOrder(b, now);
      if (aDeadline !== bDeadline) return aDeadline - bDeadline;
      return a.rank - b.rank;
    });
  const rest = items
    .filter((item) => !attentionIsDecideNow(item, now))
    .sort((a, b) => {
      const diff = attentionArrivalTimestamp(b) - attentionArrivalTimestamp(a);
      if (diff !== 0) return diff;
      return a.rank - b.rank;
    });
  const newToday = rest.filter((item) => attentionIsNewToday(item, now));
  const earlier = rest.filter((item) => !attentionIsNewToday(item, now));

  const shelves: DeskShelf[] = [];
  if (decideNow.length > 0) shelves.push({ key: "desk:decide-now", label: "Decide now", items: decideNow });
  if (newToday.length > 0) shelves.push({ key: "desk:new-today", label: "New today", items: newToday });
  if (earlier.length > 0) shelves.push({ key: "desk:earlier", label: "Earlier", items: earlier });
  return shelves;
}

function attentionArrivalTimestamp(item: AttentionItem): number {
  const ts = new Date(item.createdAt).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

// ---------------------------------------------------------------------------
// Aging shelf (PAP-16032 §4.4) — items idle past the threshold leave the desk.
// ---------------------------------------------------------------------------

/** Default idle threshold before an item drops from the desk to the shelf. */
export const ATTENTION_AGING_DAYS = 30;

/** Milliseconds since the item last saw activity. */
export function attentionIdleMs(item: AttentionItem, now: number): number {
  const ts = new Date(item.activityAt).getTime();
  return Number.isFinite(ts) ? Math.max(0, now - ts) : 0;
}

/** Server-computed shelf membership, including per-queue retention overrides. */
export function attentionIsAging(item: AttentionItem): boolean {
  return item.shelf;
}

/** Idle duration in whole days, for the shelf's "idle N days" label. */
export function attentionIdleDays(item: AttentionItem, now: number): number {
  return Math.floor(attentionIdleMs(item, now) / MS_PER_DAY_DECIDE);
}

// ---------------------------------------------------------------------------
// Decide-by control (triage strip) — the segmented options an operator/agent
// picks from. `date` is handled separately by a date input.
// ---------------------------------------------------------------------------

export type DecideByPreset = "today" | "this_week" | "whenever";

export const DECIDE_BY_OPTIONS: ReadonlyArray<[DecideByPreset, string]> = [
  ["today", "Today"],
  ["this_week", "This week"],
  ["whenever", "Whenever"],
];

/** Human label for any stored `decideBy` value (preset or `YYYY-MM-DD`). */
export function decideByLabel(decideBy: string | null): string {
  if (!decideBy) return "Not set";
  if (decideBy === "today") return "Today";
  if (decideBy === "this_week") return "This week";
  if (decideBy === "whenever") return "Whenever";
  if (/^\d{4}-\d{2}-\d{2}$/.test(decideBy)) {
    const parsed = new Date(`${decideBy}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime())
      ? parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
      : decideBy;
  }
  return decideBy;
}

// ---------------------------------------------------------------------------
// Date-range chips (PAP-16032 §4.2) — resolve to server-side activity bounds.
// The desk filters `activityAt` server-side (activitySince/Until) rather than
// shipping the whole feed and filtering on the client.
// ---------------------------------------------------------------------------

export type AttentionDateRangeId = "all" | "today" | "yesterday" | "last_7_days" | "this_month" | "custom";

export const ATTENTION_DATE_RANGE_OPTIONS: ReadonlyArray<[AttentionDateRangeId, string]> = [
  ["all", "All"],
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["last_7_days", "Last 7 days"],
  ["this_month", "This month"],
];

export interface AttentionActivityBounds {
  activitySince?: string;
  activityUntil?: string;
}

/**
 * Resolve a range chip to `{activitySince, activityUntil}` ISO bounds. Uses
 * local calendar boundaries (what the operator means by "today"); `custom`
 * takes the caller's explicit from/to dates.
 */
export function resolveAttentionDateRange(
  range: AttentionDateRangeId,
  now: number,
  custom?: { from?: string | null; to?: string | null },
): AttentionActivityBounds {
  const startOfLocalDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const endOfLocalDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(23, 59, 59, 999);
    return d;
  };
  switch (range) {
    case "all":
      return {};
    case "today":
      return { activitySince: startOfLocalDay(now).toISOString() };
    case "yesterday": {
      const start = startOfLocalDay(now - MS_PER_DAY_DECIDE);
      const end = endOfLocalDay(now - MS_PER_DAY_DECIDE);
      return { activitySince: start.toISOString(), activityUntil: end.toISOString() };
    }
    case "last_7_days":
      return { activitySince: startOfLocalDay(now - 6 * MS_PER_DAY_DECIDE).toISOString() };
    case "this_month": {
      const d = new Date(now);
      const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
      return { activitySince: start.toISOString() };
    }
    case "custom": {
      const bounds: AttentionActivityBounds = {};
      if (custom?.from) {
        const from = new Date(`${custom.from}T00:00:00`);
        if (Number.isFinite(from.getTime())) bounds.activitySince = from.toISOString();
      }
      if (custom?.to) {
        const to = new Date(`${custom.to}T23:59:59.999`);
        if (Number.isFinite(to.getTime())) bounds.activityUntil = to.toISOString();
      }
      return bounds;
    }
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Grouping / sorting / filtering (PAP-13408 — Inbox-style toolbar)
//
// The queue defaults to no grouping, sorted by `activityAt` desc, mirroring the
// `InboxWorkItemGroupBy` pattern in `lib/inbox.ts`. All of these are pure
// functions so the page can re-bucket on the client without refetching, and so
// the logic is unit-tested independently of React.
// ---------------------------------------------------------------------------

export type AttentionGroupBy = "none" | "date" | "type" | "project" | "severity";
export type AttentionSortOrder = "newest" | "oldest";

/** Ordered list used to render the group-by picker (label + value). */
export const ATTENTION_GROUP_BY_OPTIONS: ReadonlyArray<[AttentionGroupBy, string]> = [
  ["none", "None"],
  ["date", "Date"],
  ["type", "Type"],
  ["project", "Project"],
  ["severity", "Severity"],
];

export const ATTENTION_SORT_OPTIONS: ReadonlyArray<[AttentionSortOrder, string]> = [
  ["newest", "Newest first"],
  ["oldest", "Oldest first"],
];

/**
 * Filter selections. Empty arrays mean "no filter" (show everything). The
 * `__none__` sentinel represents rows with no project / workspace.
 */
export interface AttentionFilterState {
  sourceKinds: AttentionSourceKind[];
  projectIds: string[];
  workspaceIds: string[];
  severities: AttentionSeverity[];
}

export const NO_GROUP_SENTINEL = "__none__";

export const defaultAttentionFilterState: AttentionFilterState = {
  sourceKinds: [],
  projectIds: [],
  workspaceIds: [],
  severities: [],
};

export interface AttentionGroup {
  key: string;
  label: string | null;
  items: AttentionItem[];
}

export interface AttentionFilterOptions {
  sourceKinds: AttentionSourceKind[];
  projects: AttentionProjectRef[];
  workspaces: AttentionWorkspaceRef[];
  severities: AttentionSeverity[];
  /** True when at least one row has no project (adds a "No project" option). */
  hasNoProject: boolean;
  /** True when at least one row has no workspace. */
  hasNoWorkspace: boolean;
}

export const ATTENTION_GROUP_BY_KEY = "paperclip:attention:group-by";
export const ATTENTION_SORT_KEY = "paperclip:attention:sort";
export const ATTENTION_FILTERS_KEY_PREFIX = "paperclip:attention:filters";
export const ATTENTION_COLLAPSED_GROUPS_KEY_PREFIX = "paperclip:attention:collapsed-groups";

function isAttentionGroupBy(value: unknown): value is AttentionGroupBy {
  return value === "none" || value === "date" || value === "type" || value === "project" || value === "severity";
}

export function loadAttentionGroupBy(): AttentionGroupBy {
  try {
    const raw = localStorage.getItem(ATTENTION_GROUP_BY_KEY);
    return isAttentionGroupBy(raw) ? raw : "none";
  } catch {
    return "none";
  }
}

export function saveAttentionGroupBy(groupBy: AttentionGroupBy) {
  try {
    localStorage.setItem(ATTENTION_GROUP_BY_KEY, groupBy);
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadAttentionSortOrder(): AttentionSortOrder {
  try {
    const raw = localStorage.getItem(ATTENTION_SORT_KEY);
    return raw === "oldest" ? "oldest" : "newest";
  } catch {
    return "newest";
  }
}

export function saveAttentionSortOrder(order: AttentionSortOrder) {
  try {
    localStorage.setItem(ATTENTION_SORT_KEY, order);
  } catch {
    // Ignore localStorage failures.
  }
}

function getAttentionFiltersStorageKey(companyId: string | null | undefined): string | null {
  if (!companyId) return null;
  return `${ATTENTION_FILTERS_KEY_PREFIX}:${companyId}`;
}

function getAttentionCollapsedGroupsStorageKey(companyId: string | null | undefined): string | null {
  if (!companyId) return null;
  return `${ATTENTION_COLLAPSED_GROUPS_KEY_PREFIX}:${companyId}`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

const ALL_SEVERITIES: AttentionSeverity[] = ["critical", "high", "medium", "low"];

export function loadAttentionFilters(companyId: string | null | undefined): AttentionFilterState {
  const storageKey = getAttentionFiltersStorageKey(companyId);
  if (!storageKey) return { ...defaultAttentionFilterState };
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { ...defaultAttentionFilterState };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      sourceKinds: normalizeStringArray(parsed.sourceKinds) as AttentionSourceKind[],
      projectIds: normalizeStringArray(parsed.projectIds),
      workspaceIds: normalizeStringArray(parsed.workspaceIds),
      severities: normalizeStringArray(parsed.severities).filter((s): s is AttentionSeverity =>
        (ALL_SEVERITIES as string[]).includes(s),
      ),
    };
  } catch {
    return { ...defaultAttentionFilterState };
  }
}

export function saveAttentionFilters(
  companyId: string | null | undefined,
  filters: AttentionFilterState,
) {
  const storageKey = getAttentionFiltersStorageKey(companyId);
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(filters));
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadCollapsedAttentionGroupKeys(companyId: string | null | undefined): Set<string> {
  const storageKey = getAttentionCollapsedGroupsStorageKey(companyId);
  if (!storageKey) return new Set();
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedAttentionGroupKeys(
  companyId: string | null | undefined,
  groupKeys: ReadonlySet<string>,
) {
  const storageKey = getAttentionCollapsedGroupsStorageKey(companyId);
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify([...groupKeys]));
  } catch {
    // Ignore localStorage failures.
  }
}

export function countActiveAttentionFilters(filters: AttentionFilterState): number {
  return (
    filters.sourceKinds.length +
    filters.projectIds.length +
    filters.workspaceIds.length +
    filters.severities.length
  );
}

function attentionActivityTimestamp(item: AttentionItem): number {
  const ts = new Date(item.activityAt).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Sort by activity time in the requested direction. `rank` is the stable
 * tiebreaker (lower rank = higher priority) so equal-timestamp rows keep the
 * server's escalation order.
 */
export function sortAttentionItems(items: AttentionItem[], order: AttentionSortOrder): AttentionItem[] {
  const sign = order === "oldest" ? -1 : 1;
  return [...items].sort((a, b) => {
    const diff = attentionActivityTimestamp(b) - attentionActivityTimestamp(a);
    if (diff !== 0) return sign * diff;
    return a.rank - b.rank;
  });
}

export function attentionItemMatchesFilters(item: AttentionItem, filters: AttentionFilterState): boolean {
  if (filters.sourceKinds.length > 0 && !filters.sourceKinds.includes(item.sourceKind)) return false;
  if (filters.severities.length > 0 && !filters.severities.includes(item.severity)) return false;
  if (filters.projectIds.length > 0) {
    const projectId = item.project?.id ?? NO_GROUP_SENTINEL;
    if (!filters.projectIds.includes(projectId)) return false;
  }
  if (filters.workspaceIds.length > 0) {
    const workspaceId = item.workspace?.id ?? NO_GROUP_SENTINEL;
    if (!filters.workspaceIds.includes(workspaceId)) return false;
  }
  return true;
}

export function filterAttentionItems(items: AttentionItem[], filters: AttentionFilterState): AttentionItem[] {
  if (countActiveAttentionFilters(filters) === 0) return items;
  return items.filter((item) => attentionItemMatchesFilters(item, filters));
}

/** Distinct filterable dimensions present in the current feed, for the picker. */
export function buildAttentionFilterOptions(items: AttentionItem[]): AttentionFilterOptions {
  const sourceKinds = new Set<AttentionSourceKind>();
  const projects = new Map<string, AttentionProjectRef>();
  const workspaces = new Map<string, AttentionWorkspaceRef>();
  const severities = new Set<AttentionSeverity>();
  let hasNoProject = false;
  let hasNoWorkspace = false;

  for (const item of items) {
    sourceKinds.add(item.sourceKind);
    severities.add(item.severity);
    if (item.project) projects.set(item.project.id, item.project);
    else hasNoProject = true;
    if (item.workspace) workspaces.set(item.workspace.id, item.workspace);
    else hasNoWorkspace = true;
  }

  return {
    sourceKinds: [...sourceKinds].sort((a, b) => sourceMeta(a).label.localeCompare(sourceMeta(b).label)),
    projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)),
    workspaces: [...workspaces.values()].sort((a, b) => a.name.localeCompare(b.name)),
    severities: ALL_SEVERITIES.filter((s) => severities.has(s)),
    hasNoProject,
    hasNoWorkspace,
  };
}

export interface AttentionRenderPlan {
  /** Rows to render per group key (empty for collapsed groups). */
  groupRows: Map<string, AttentionItem[]>;
  snoozedRows: AttentionItem[];
  dismissedRows: AttentionItem[];
  /** True when at least one visible row was left unrendered by the budget. */
  hasMoreRows: boolean;
}

/**
 * Allocate a bounded render budget across the queue in document order — active
 * groups first, then the open curtains (PAP-13784). The feed is uncapped, so
 * the page renders only `limit` rows and grows the budget as the user scrolls;
 * collapsed groups and closed curtains cost nothing.
 */
export function planAttentionRenderRows(options: {
  groups: AttentionGroup[];
  collapsedGroupKeys: ReadonlySet<string>;
  snoozedItems: AttentionItem[];
  snoozedOpen: boolean;
  dismissedItems: AttentionItem[];
  dismissedOpen: boolean;
  limit: number;
}): AttentionRenderPlan {
  let remaining = options.limit;
  let truncated = false;
  const take = (items: AttentionItem[]): AttentionItem[] => {
    const slice = items.slice(0, Math.max(0, remaining));
    remaining -= slice.length;
    if (slice.length < items.length) truncated = true;
    return slice;
  };
  const groupRows = new Map<string, AttentionItem[]>();
  for (const group of options.groups) {
    const collapsed = group.label !== null && options.collapsedGroupKeys.has(group.key);
    groupRows.set(group.key, collapsed ? [] : take(group.items));
  }
  const snoozedRows = options.snoozedOpen ? take(options.snoozedItems) : [];
  const dismissedRows = options.dismissedOpen ? take(options.dismissedItems) : [];
  return { groupRows, snoozedRows, dismissedRows, hasMoreRows: truncated };
}

const DATE_BUCKET_ORDER = ["today", "yesterday", "this_week", "earlier"] as const;
type DateBucket = (typeof DATE_BUCKET_ORDER)[number];

const DATE_BUCKET_LABELS: Record<DateBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This week",
  earlier: "Earlier",
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Bucket a timestamp relative to `now` using a rolling calendar-day window. */
export function attentionDateBucket(activityAt: string, now: number): DateBucket {
  const ts = new Date(activityAt).getTime();
  if (!Number.isFinite(ts)) return "earlier";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayStart = startOfToday.getTime();
  if (ts >= todayStart) return "today";
  if (ts >= todayStart - MS_PER_DAY) return "yesterday";
  // Rolling 7-day window from the start of today (locale week-start agnostic).
  if (ts >= todayStart - 6 * MS_PER_DAY) return "this_week";
  return "earlier";
}

const SEVERITY_LABEL: Record<AttentionSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/**
 * Bucket items into ordered sections. Item order *within* each group is
 * preserved from the input (which the caller sorts first), so the sort toggle
 * still governs intra-group ordering. Group ordering is fixed for date/severity
 * and most-recent-first for type/project.
 */
export function groupAttentionItems(
  items: AttentionItem[],
  groupBy: AttentionGroupBy,
  options: { now?: number } = {},
): AttentionGroup[] {
  if (items.length === 0) return [];

  if (groupBy === "none") {
    return [{ key: "__all", label: null, items }];
  }

  if (groupBy === "date") {
    const now = options.now ?? Date.now();
    const buckets = new Map<DateBucket, AttentionItem[]>();
    for (const item of items) {
      const bucket = attentionDateBucket(item.activityAt, now);
      const list = buckets.get(bucket) ?? [];
      list.push(item);
      buckets.set(bucket, list);
    }
    return DATE_BUCKET_ORDER.filter((bucket) => buckets.has(bucket)).map((bucket) => ({
      key: `date:${bucket}`,
      label: DATE_BUCKET_LABELS[bucket],
      items: buckets.get(bucket)!,
    }));
  }

  if (groupBy === "severity") {
    const buckets = new Map<AttentionSeverity, AttentionItem[]>();
    for (const item of items) {
      const list = buckets.get(item.severity) ?? [];
      list.push(item);
      buckets.set(item.severity, list);
    }
    return ALL_SEVERITIES.filter((s) => buckets.has(s)).map((severity) => ({
      key: `severity:${severity}`,
      label: SEVERITY_LABEL[severity],
      items: buckets.get(severity)!,
    }));
  }

  // type / project: group, then order groups by most-recent activity so the
  // freshest section floats to the top (matching Inbox's issue-group ordering).
  const groups = new Map<string, { label: string; items: AttentionItem[]; latest: number }>();
  for (const item of items) {
    const resolved =
      groupBy === "type"
        ? { key: `type:${item.sourceKind}`, label: sourceMeta(item.sourceKind).label }
        : item.project
          ? { key: `project:${item.project.id}`, label: item.project.name }
          : { key: `project:${NO_GROUP_SENTINEL}`, label: "No project" };
    const existing = groups.get(resolved.key);
    const ts = attentionActivityTimestamp(item);
    if (existing) {
      existing.items.push(item);
      existing.latest = Math.max(existing.latest, ts);
    } else {
      groups.set(resolved.key, { label: resolved.label, items: [item], latest: ts });
    }
  }

  return [...groups.entries()]
    .sort(([, a], [, b]) => {
      const diff = b.latest - a.latest;
      if (diff !== 0) return diff;
      return a.label.localeCompare(b.label);
    })
    .map(([key, value]) => ({ key, label: value.label, items: value.items }));
}
