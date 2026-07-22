import type { PluginContext } from "@paperclipai/plugin-sdk";
import { supersededRecurringIssues } from "./recurring-issue-lifecycle.js";
import { listAllCompanyIssues } from "./issue-pagination.js";
import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

// The "meeting with Alan": a deterministic, decision-ready Founder Brief composed
// from live workforce + ck_eval state, posted as an issue (the agenda) assigned to
// the owner, with 1-3 tap-to-decide interactions surfaced in the owner's Inbox. On
// the next run the job re-polls those interactions and writes back the owner's choice.
export const JOB_FOUNDER_BRIEF = "ck.founder-brief";

// The human owner / board principal in this instance (user.id = "local-board").
const OWNER_USER_ID = "local-board";

// State key (instance scope) holding the list of decisions awaiting the owner.
const PENDING_STATE_KEY = "founder-brief:pending-decisions";

export function founderBriefIssueStatus(pendingDecisionCount: number): "in_review" | "done" {
  return pendingDecisionCount > 0 ? "in_review" : "done";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingDecision {
  /** The issue_thread_interaction id to re-poll. */
  id: string;
  /** The brief issue the interaction lives on. */
  issueId: string;
  /** Decision discriminator. */
  type: "activate-draft-seats" | "ack-reds";
  /** ck_eval.agent_spec ids the decision acts on (for activate-draft-seats). */
  specIds: string[];
  /** Day the decision was raised (YYYY-MM-DD). */
  day: string;
  /** Set once the writeback has been applied so we never act twice. */
  handled?: boolean;
  /** Terminal interaction status observed at writeback time. */
  resolvedStatus?: string;
}

interface SpecRow {
  spec_id: string;
  name: string;
  type: string | null;
  spec_status: string | null;
  verdict: string | null;
  cost_adjusted_score: string | number | null;
  period_end: Date | string | null;
}

interface DraftSeatRow {
  spec_id: string;
  name: string;
  coordination_status: string | null;
}

interface BriefState {
  wins: SpecRow[];
  reds: SpecRow[];
  costCents: number;
  pricedCostEventCount: number;
  nonPricedCostEventCount: number;
  draftSeats: DraftSeatRow[];
  focus: string[];
}

// ---------------------------------------------------------------------------
// Schema: record the owner's coordination decision ON the spec rows.
// We add two nullable columns rather than touch `status` (draft -> active would
// fabricate certification). `coordination_status` is the human-set next state and
// `coordination_decision` is the audit record of who/when/why. Idempotent.
// ---------------------------------------------------------------------------

async function ensureWritebackColumns(sql: Sql): Promise<void> {
  await sql`alter table ck_eval.agent_spec add column if not exists coordination_status text`;
  await sql`alter table ck_eval.agent_spec add column if not exists coordination_decision jsonb`;
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

async function getPending(ctx: PluginContext): Promise<PendingDecision[]> {
  const raw = await ctx.state.get({ scopeKind: "instance", stateKey: PENDING_STATE_KEY });
  return Array.isArray(raw) ? (raw as PendingDecision[]) : [];
}

async function setPending(ctx: PluginContext, pending: PendingDecision[]): Promise<void> {
  await ctx.state.set({ scopeKind: "instance", stateKey: PENDING_STATE_KEY }, pending);
}

// ---------------------------------------------------------------------------
// Compose: gather live state for the brief
// ---------------------------------------------------------------------------

async function gatherState(
  ctx: PluginContext,
  companyId: string,
  sql: Sql,
): Promise<BriefState> {
  // Latest scorecard verdict per registered spec; split into wins (keep) / reds (quarantine).
  const specRows = (await sql`
    select
      spec.id   as spec_id,
      spec.name as name,
      spec.type as type,
      spec.status as spec_status,
      sc.verdict as verdict,
      sc.cost_adjusted_score as cost_adjusted_score,
      sc.period_end as period_end
    from ck_eval.agent_spec spec
    left join lateral (
      select verdict, cost_adjusted_score, period_end
      from ck_eval.scorecard
      where spec_id = spec.id
      order by period_end desc
      limit 1
    ) sc on true
    order by sc.period_end desc nulls last, spec.name
  `) as unknown as SpecRow[];

  const wins = specRows.filter((r) => r.verdict === "keep").slice(0, 5);
  const reds = specRows.filter(
    (r) => r.verdict === "quarantine" || r.spec_status === "quarantined",
  );

  // Runway / compute cost: report only explicitly priced metered API usage as
  // spend. Subscription-included and legacy/unpriced rows remain visible as a
  // coverage caveat instead of being mixed into the spend denominator.
  const costRows = (await sql`
    select
      coalesce(sum(cost_cents) filter (
        where billing_type = 'metered_api' and cost_cents > 0
      ), 0)::numeric as total,
      count(*) filter (
        where billing_type = 'metered_api' and cost_cents > 0
      )::int as priced_count,
      count(*) filter (
        where billing_type <> 'metered_api' or cost_cents <= 0
      )::int as non_priced_count
    from public.cost_events
    where company_id = ${companyId}
  `) as unknown as Array<{
    total: string | number;
    priced_count: number;
    non_priced_count: number;
  }>;
  const costCents = Number(costRows[0]?.total ?? 0);
  const pricedCostEventCount = Number(costRows[0]?.priced_count ?? 0);
  const nonPricedCostEventCount = Number(costRows[0]?.non_priced_count ?? 0);

  // Draft coordination seats + any human decision already recorded.
  const draftSeats = (await sql`
    select id as spec_id, name, coordination_status
    from ck_eval.agent_spec
    where status = 'draft'
    order by name
  `) as unknown as DraftSeatRow[];

  // Today's focus: open board issues that aren't our own brief/huddle operations.
  const issues = await listAllCompanyIssues(ctx.issues, companyId);
  const focus = issues
    .filter(
      (i) =>
        i.status !== "done" &&
        i.status !== "cancelled" &&
        !i.title.startsWith("Founder Brief") &&
        !i.title.startsWith("Daily Huddle"),
    )
    .slice(0, 6)
    .map((i) => i.title);

  return {
    wins,
    reds,
    costCents,
    pricedCostEventCount,
    nonPricedCostEventCount,
    draftSeats,
    focus,
  };
}

function fmtScore(v: string | number | null): string {
  if (v == null) return "n/a";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(3) : "n/a";
}

export function renderFounderBriefCostLines(input: {
  costCents: number;
  pricedCostEventCount: number;
  nonPricedCostEventCount: number;
}): string[] {
  const usd = (input.costCents / 100).toFixed(2);
  const lines = [
    `  - Recorded metered API spend: $${usd} across ${input.pricedCostEventCount} priced event(s).`,
  ];
  if (input.nonPricedCostEventCount > 0) {
    lines.push(
      `  - Coverage note: ${input.nonPricedCostEventCount} subscription-included or unpriced event(s) are excluded from spend.`,
    );
  }
  return lines;
}

function renderBrief(state: BriefState, today: string, trigger: string): string {
  const undecidedSeats = state.draftSeats.filter((s) => !s.coordination_status);

  const lines: string[] = [
    `CK IT Solutions — Founder Brief — ${today}`,
    `(decision-ready brief composed by the CK Evaluation Office plugin; trigger=${trigger})`,
    ``,
    `## Wins (recent \`keep\` verdicts) — ${state.wins.length}`,
    ...(state.wins.length
      ? state.wins.map((w) => `  - ${w.name} — cost-adj score ${fmtScore(w.cost_adjusted_score)}`)
      : ["  - (none yet)"]),
    ``,
    `## Today's focus — ${state.focus.length} open item(s)`,
    ...(state.focus.length ? state.focus.map((t) => `  - ${t}`) : ["  - Board clear."]),
    ``,
    `## Runway / compute cost`,
    ...renderFounderBriefCostLines(state),
    ``,
    `## Reds (quarantine / blockers) — ${state.reds.length}`,
    ...(state.reds.length
      ? state.reds.map((r) => `  - ${r.name} — verdict ${r.verdict ?? r.spec_status}`)
      : ["  - None."]),
    ``,
    `## Status (FYI — internal, nothing to tap)`,
  ];

  if (undecidedSeats.length) {
    lines.push(
      `  - ${undecidedSeats.length} draft coordination seat(s) still internal / not activated (${undecidedSeats
        .map((s) => s.name)
        .join(", ")}). Say the word if you ever want them turned on.`,
    );
  }
  if (state.reds.length) {
    lines.push(
      `  - ${state.reds.length} unit(s) in quarantine — internal knowledge hygiene, handled by the system; nothing for you to do.`,
    );
  }
  if (!undecidedSeats.length && !state.reds.length) {
    lines.push(`  - All clear.`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Writeback: act on the owner's resolved decisions (runs at the start of a job).
// ---------------------------------------------------------------------------

interface InteractionStateRow {
  status: string;
  result: unknown;
  resolved_by_user_id: string | null;
  resolved_at: Date | string | null;
}

async function processPendingDecisions(
  ctx: PluginContext,
  companyId: string,
  sql: Sql,
): Promise<number> {
  const pending = await getPending(ctx);
  if (!pending.length) return 0;

  let changed = false;
  let actedCount = 0;

  for (const d of pending) {
    if (d.handled) continue;

    const rows = (await sql`
      select status, result, resolved_by_user_id, resolved_at
      from public.issue_thread_interactions
      where id = ${d.id}
      limit 1
    `) as unknown as InteractionStateRow[];
    const row = rows[0];
    if (!row) continue; // interaction vanished; leave for a later pass
    if (row.status === "pending") continue; // owner hasn't decided yet

    const accepted = row.status === "accepted";
    const decidedBy = row.resolved_by_user_id ?? "owner";
    const decidedAt = row.resolved_at ? new Date(row.resolved_at).toISOString() : new Date().toISOString();

    if (d.type === "activate-draft-seats") {
      if (accepted) {
        const decisionRecord = {
          decision: "queued_for_golden_set",
          rationale: "Owner approved activation of draft coordination seats via Founder Brief.",
          decidedByUserId: decidedBy,
          decidedAt,
          briefIssueId: d.issueId,
          interactionId: d.id,
          note: "Recorded human approval only — NOT certified; next step is golden-set authoring + eval before activation.",
        };
        await sql`
          update ck_eval.agent_spec
          set coordination_status = 'queued_for_golden_set',
              coordination_decision = ${sql.json(decisionRecord as never)},
              updated_at = now()
          where id::text = any(${d.specIds}) and status = 'draft'
        `;
        await ctx.issues.createComment(
          d.issueId,
          `Decision applied: **Activate draft coordination seats — APPROVED** by ${decidedBy}. ` +
            `${d.specIds.length} spec(s) marked \`queued_for_golden_set\` (still \`draft\` — not certified; golden-set + eval next).`,
          companyId,
        );
        await ctx.activity.log({
          companyId,
          message: `Founder Brief writeback: owner approved — ${d.specIds.length} draft coordination seats queued for golden-set.`,
          entityType: "issue",
          entityId: d.issueId,
          metadata: { decision: d.type, outcome: "accepted", specIds: d.specIds },
        });
      } else {
        const decisionRecord = {
          decision: "activation_skipped",
          decidedByUserId: decidedBy,
          decidedAt,
          briefIssueId: d.issueId,
          interactionId: d.id,
          interactionStatus: row.status,
        };
        await sql`
          update ck_eval.agent_spec
          set coordination_status = 'activation_skipped',
              coordination_decision = ${sql.json(decisionRecord as never)},
              updated_at = now()
          where id::text = any(${d.specIds}) and status = 'draft'
        `;
        await ctx.issues.createComment(
          d.issueId,
          `Decision applied: **Activate draft coordination seats — SKIPPED** (${row.status}) by ${decidedBy}. ` +
            `Recorded \`activation_skipped\` on ${d.specIds.length} spec(s).`,
          companyId,
        );
        await ctx.activity.log({
          companyId,
          message: `Founder Brief writeback: owner skipped draft-seat activation (${row.status}).`,
          entityType: "issue",
          entityId: d.issueId,
          metadata: { decision: d.type, outcome: row.status, specIds: d.specIds },
        });
      }
    } else if (d.type === "ack-reds") {
      // Lightweight decision: record the human's acknowledgement of the reds.
      await ctx.issues.createComment(
        d.issueId,
        accepted
          ? `Decision applied: **Quarantine reds — ACKNOWLEDGED** by ${decidedBy}.`
          : `Decision applied: **Quarantine reds — deferred** (${row.status}) by ${decidedBy}.`,
        companyId,
      );
      await ctx.activity.log({
        companyId,
        message: `Founder Brief writeback: owner ${accepted ? "acknowledged" : "deferred"} quarantine reds.`,
        entityType: "issue",
        entityId: d.issueId,
        metadata: { decision: d.type, outcome: row.status },
      });
    }

    d.handled = true;
    d.resolvedStatus = row.status;
    changed = true;
    actedCount += 1;
    ctx.logger.info(`Founder Brief: wrote back decision ${d.type} (${row.status}) for interaction ${d.id}`);
  }

  if (changed) await setPending(ctx, pending);
  return actedCount;
}

// ---------------------------------------------------------------------------
// Telegram (built but OFF). Only fires if telegramChatId is configured; resolves
// the bot token from a secret reference. No chat_id is set, so this NEVER sends.
// ---------------------------------------------------------------------------

async function maybePushTelegram(ctx: PluginContext, text: string): Promise<void> {
  let cfg: Record<string, unknown> | null = null;
  try {
    cfg = (await ctx.config.get()) as Record<string, unknown> | null;
  } catch {
    cfg = null;
  }
  const chatId = typeof cfg?.telegramChatId === "string" ? cfg.telegramChatId.trim() : "";
  if (!chatId) {
    ctx.logger.info("Founder Brief: Telegram push disabled (no telegramChatId configured) — nothing sent.");
    return;
  }
  const tokenRef = typeof cfg?.telegramBotTokenRef === "string" ? cfg.telegramBotTokenRef.trim() : "";
  if (!tokenRef) {
    ctx.logger.warn("Founder Brief: telegramChatId set but telegramBotTokenRef missing — skipping push.");
    return;
  }
  const token = await ctx.secrets.resolve(tokenRef);
  await ctx.http.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  ctx.logger.info("Founder Brief: Telegram push sent.");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFounderBrief(
  ctx: PluginContext,
  deps: { getSql: () => Promise<Sql>; companyName: string },
): void {
  ctx.jobs.register(JOB_FOUNDER_BRIEF, async (job) => {
    const companies = await ctx.companies.list({ limit: 100 });
    const ck = companies.find((c) => c.name === deps.companyName);
    if (!ck) {
      ctx.logger.warn(`Founder Brief: company '${deps.companyName}' not found`);
      return;
    }
    const sql = await deps.getSql();
    await ensureWritebackColumns(sql);

    // 1) Act on any decisions the owner resolved since the last run (writeback).
    const acted = await processPendingDecisions(ctx, ck.id, sql);

    // 2) Compose today's brief from live state.
    const state = await gatherState(ctx, ck.id, sql);
    const today = new Date().toISOString().slice(0, 10);
    const title = `Founder Brief — ${today}`;
    const description = renderBrief(state, today, job.trigger);

    // 3) Find-or-create today's brief issue (the agenda), assigned to the owner.
    const issues = await listAllCompanyIssues(ctx.issues, ck.id);
    let brief = issues.find((i) => i.title === title);
    if (!brief) {
      brief = await ctx.issues.create({
        companyId: ck.id,
        title,
        description,
        status: "todo",
        assigneeUserId: OWNER_USER_ID,
      });
      ctx.logger.info(`Founder Brief posted: '${title}' (${brief.id})`);
    } else {
      await ctx.issues.update(brief.id, { description }, ck.id);
      ctx.logger.info(`Founder Brief refreshed: '${title}' (${brief.id})`);
    }

    // A newer brief supersedes an older snapshot, but an older brief with an
    // unresolved decision remains actionable and must stay open.
    const priorBriefIds = issues
      .filter((issue) => issue.title !== title && issue.title.startsWith("Founder Brief — "))
      .map((issue) => issue.id);
    const pendingRows = priorBriefIds.length
      ? await sql`select distinct issue_id from issue_thread_interactions
          where issue_id = any(${priorBriefIds}) and status = 'pending'` as Array<{ issue_id: string }>
      : [];
    const pendingIssueIds = new Set(pendingRows.map((row) => row.issue_id));
    const superseded = supersededRecurringIssues(
      issues,
      title,
      "Founder Brief — ",
      pendingIssueIds,
    );
    for (const issue of superseded) {
      await ctx.issues.update(issue.id, { status: "done" }, ck.id);
    }
    if (superseded.length) {
      ctx.logger.info(
        `Founder Brief: completed ${superseded.length} superseded brief(s) without pending decisions`,
      );
    }

    // 4) Surface 1-3 tap-to-decide interactions; track them for next-run writeback.
    const pending = await getPending(ctx);
    const trackedInteractionIds = new Set(pending.map((p) => p.id));

    // Owner rule 2026-07-06: internal governance (seat activation, quarantine acks) is NEVER a
    // tap-to-decide card — it's reported FYI in the brief text above. ONLY genuine business
    // decisions (e.g. "send this email to this venue") ever become human cards. Flip to re-enable.
    const ESCALATE_INTERNAL_GOVERNANCE = false;
    // Primary, REAL decision: activate the draft coordination seats.
    const undecidedSeats = state.draftSeats.filter((s) => !s.coordination_status);
    if (ESCALATE_INTERNAL_GOVERNANCE && undecidedSeats.length) {
      const interaction = await ctx.issues.requestConfirmation(
        brief.id,
        {
          title: "Activate the draft coordination seats?",
          summary: `${undecidedSeats.length} GOV coordination seats are drafted and awaiting your go.`,
          continuationPolicy: "none",
          idempotencyKey: `founder-brief:${today}:activate-draft-seats`,
          payload: {
            version: 1,
            prompt: `Activate the ${undecidedSeats.length} draft coordination seats (queue them for golden-set + eval)?`,
            acceptLabel: "Activate",
            rejectLabel: "Skip",
            allowDeclineReason: true,
            detailsMarkdown:
              `**Was ist das?** Diese Agenten-Sitze sind fertig entworfen, aber noch nicht im Einsatz. ` +
              `Bevor ein Agent arbeiten darf, braucht er deine Freigabe + eine Prüfung (Testfälle + Bewertung).\n\n` +
              `Seats: ${undecidedSeats.map((s) => `\`${s.name}\``).join(", ")}.\n\n` +
              `**Wenn du "Activate" drückst:** deine Entscheidung wird protokolliert und der Sitz kommt in die ` +
              `Prüf-Warteschlange (\`queued_for_golden_set\`). Es passiert nichts Unumkehrbares — der Agent arbeitet ` +
              `erst nach bestandener Prüfung.\n\n` +
              `**Wenn du "Skip" drückst:** alles bleibt wie es ist; die Frage kommt wieder, solange der Sitz im Entwurf steht.\n\n` +
              `**Nicht sicher?** Skip ist immer sicher. Details: CK Evaluation Seite (Zeile des Agenten).`,
          },
        },
        ck.id,
      );
      if (!trackedInteractionIds.has(interaction.id)) {
        pending.push({
          id: interaction.id,
          issueId: brief.id,
          type: "activate-draft-seats",
          specIds: undecidedSeats.map((s) => s.spec_id),
          day: today,
          handled: interaction.status !== "pending" ? true : undefined,
          resolvedStatus: interaction.status !== "pending" ? interaction.status : undefined,
        });
      }
    }

    // Secondary decision: acknowledge quarantine reds (lightweight writeback).
    if (ESCALATE_INTERNAL_GOVERNANCE && state.reds.length) {
      const interaction = await ctx.issues.requestConfirmation(
        brief.id,
        {
          title: "Acknowledge the quarantined units?",
          summary: `${state.reds.length} unit(s) are in quarantine.`,
          continuationPolicy: "none",
          idempotencyKey: `founder-brief:${today}:ack-reds`,
          payload: {
            version: 1,
            prompt: `Acknowledge ${state.reds.length} quarantined unit(s) flagged for review?`,
            acceptLabel: "Acknowledge",
            rejectLabel: "Later",
            allowDeclineReason: true,
            detailsMarkdown:
              `**Was ist das?** Diese Einheiten sind in Quarantäne: ihre letzte Bewertung war schlecht genug, ` +
              `dass das System ihnen nicht mehr vertraut. Sie arbeiten weiter nichts Kritisches, bis jemand eingreift.\n\n` +
              `Reds: ${state.reds.map((r) => `\`${r.name}\``).join(", ")}.\n\n` +
              `**Wenn du "Acknowledge" drückst:** du bestätigst nur, dass du es gesehen hast (protokolliert). ` +
              `Es repariert nichts und schaltet nichts frei.\n\n` +
              `**Wenn du "Later" drückst:** die Meldung bleibt offen und kommt morgen wieder.\n\n` +
              `**Details:** CK Evaluation Seite → Zeile der Einheit → letztes Verdikt.`,
          },
        },
        ck.id,
      );
      if (!trackedInteractionIds.has(interaction.id)) {
        pending.push({
          id: interaction.id,
          issueId: brief.id,
          type: "ack-reds",
          specIds: state.reds.map((r) => r.spec_id),
          day: today,
          handled: interaction.status !== "pending" ? true : undefined,
          resolvedStatus: interaction.status !== "pending" ? interaction.status : undefined,
        });
      }
    }

    await setPending(ctx, pending);

    // 5) Optional owner push (OFF until a telegramChatId is configured).
    await maybePushTelegram(ctx, `${title}\n\nYour daily brief is ready (FYI — no action needed).`);

    // A pure FYI must not remain in the owner's actionable queue. Keep the
    // brief open only when this issue actually contains an unresolved card.
    const currentPending = await sql`select count(*)::int as count
      from issue_thread_interactions
      where issue_id = ${brief.id} and status = 'pending'` as Array<{ count: number }>;
    const briefStatus = founderBriefIssueStatus(Number(currentPending[0]?.count ?? 0));
    await ctx.issues.update(brief.id, { status: briefStatus }, ck.id);

    ctx.logger.info(
      `Founder Brief done: issue ${brief.id}, status=${briefStatus}, writebacks acted=${acted}, tracked decisions=${pending.filter((p) => !p.handled).length}.`,
    );
  });
}
