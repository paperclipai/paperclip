import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, costEvents, companies } from "@paperclipai/db";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

export interface AgentEconomics {
  agentId: string;
  agentName: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  dailyBurnCents: number;
  daysUntilCap: string; // "N/A", "Cap Exceeded", "∞", or fractional string "83.3"
}

export interface EconomicsDigest {
  companyId: string;
  generatedAt: string;
  monthStart: string;
  agents: AgentEconomics[];
}

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

/**
 * Builds the economics digest data.
 */
export async function buildEconomicsDigest(
  db: Db,
  companyId: string,
  now: Date = new Date(),
): Promise<EconomicsDigest> {
  const company = await db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);

  if (!company) {
    throw new Error(`Company not found: ${companyId}`);
  }

  const { start } = currentUtcMonthWindow(now);
  const elapsedDays = Math.max(0.1, (now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));

  // Get active agents for the company
  const companyAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.companyId, companyId));

  // Sum cost cents in the current calendar month per agent
  const spendRows = await db
    .select({
      agentId: costEvents.agentId,
      totalCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
    })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, start),
        lt(costEvents.occurredAt, now),
      ),
    )
    .groupBy(costEvents.agentId);

  const spendMap = new Map<string, number>();
  for (const r of spendRows) {
    spendMap.set(r.agentId, r.totalCents);
  }

  const agentsEconomics: AgentEconomics[] = [];

  for (const agent of companyAgents) {
    // We treat agents that are terminated or deleted differently, but here we include all listed agents
    const mtdSpendCents = spendMap.get(agent.id) ?? 0;
    const dailyBurnCents = mtdSpendCents / elapsedDays;

    let daysUntilCap = "N/A";
    if (agent.budgetMonthlyCents > 0) {
      const remainingCents = agent.budgetMonthlyCents - mtdSpendCents;
      if (remainingCents <= 0) {
        daysUntilCap = "Cap Exceeded";
      } else if (dailyBurnCents <= 0) {
        daysUntilCap = "∞";
      } else {
        daysUntilCap = (remainingCents / dailyBurnCents).toFixed(1);
      }
    }

    agentsEconomics.push({
      agentId: agent.id,
      agentName: agent.name,
      budgetMonthlyCents: agent.budgetMonthlyCents,
      spentMonthlyCents: mtdSpendCents,
      dailyBurnCents,
      daysUntilCap,
    });
  }

  // Sort by MTD spend descending
  agentsEconomics.sort((a, b) => b.spentMonthlyCents - a.spentMonthlyCents);

  return {
    companyId,
    generatedAt: now.toISOString(),
    monthStart: start.toISOString(),
    agents: agentsEconomics,
  };
}

/**
 * Formats Slack message body.
 */
export function renderEconomicsDigestSlack(digest: EconomicsDigest): string {
  const lines: string[] = [];
  lines.push(":bar_chart: *Paperclip — Weekly Agent Economics Digest*");
  lines.push(`Generated at: ${digest.generatedAt}`);
  lines.push("");
  if (digest.agents.length === 0) {
    lines.push("No active agents found.");
  } else {
    for (const a of digest.agents) {
      const capStr = a.budgetMonthlyCents > 0 ? `$${(a.budgetMonthlyCents / 100).toFixed(2)}` : "Unlimited";
      const spentStr = `$${(a.spentMonthlyCents / 100).toFixed(2)}`;
      const burnStr = `$${(a.dailyBurnCents / 100).toFixed(2)}/day`;
      const daysStr = a.daysUntilCap === "Cap Exceeded" || a.daysUntilCap === "∞" || a.daysUntilCap === "N/A"
        ? a.daysUntilCap
        : `${a.daysUntilCap} days`;

      lines.push(`• *${a.agentName}*`);
      lines.push(`  - Monthly Cap: ${capStr}`);
      lines.push(`  - MTD Spend: ${spentStr}`);
      lines.push(`  - Daily Burn: ${burnStr}`);
      lines.push(`  - Days Until Cap: ${daysStr}`);
    }
  }
  return lines.join("\n").trim();
}

/**
 * Formats Outlook email draft (subject + body).
 */
export function renderEconomicsDigestOutlook(digest: EconomicsDigest): { subject: string; body: string } {
  const dateStr = new Date(digest.generatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const subject = `[Draft] Paperclip Weekly Economics Digest - ${dateStr}`;

  const rows = digest.agents.map((a) => {
    const capStr = a.budgetMonthlyCents > 0 ? `$${(a.budgetMonthlyCents / 100).toFixed(2)}` : "Unlimited";
    const spentStr = `$${(a.spentMonthlyCents / 100).toFixed(2)}`;
    const burnStr = `$${(a.dailyBurnCents / 100).toFixed(2)}/day`;
    const daysStr = a.daysUntilCap === "Cap Exceeded" || a.daysUntilCap === "∞" || a.daysUntilCap === "N/A"
      ? a.daysUntilCap
      : `${a.daysUntilCap} days`;

    return `
    <tr>
      <td style="border: 1px solid #ddd; padding: 8px;"><b>${a.agentName}</b></td>
      <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${capStr}</td>
      <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${spentStr}</td>
      <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${burnStr}</td>
      <td style="border: 1px solid #ddd; padding: 8px; text-align: center;">${daysStr}</td>
    </tr>`;
  }).join("\n");

  const body = `
<html>
<body style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
  <h2 style="color: #2F3E46; border-bottom: 2px solid #2F3E46; padding-bottom: 8px;">Paperclip Weekly Economics Digest</h2>
  <p><b>Generated at:</b> ${digest.generatedAt}</p>
  <p>Below is the weekly summary of per-agent economics, including budget caps, month-to-date spend, daily burn rate, and days-until-cap projections.</p>
  
  <table style="border-collapse: collapse; width: 100%; max-width: 800px; font-size: 14px;">
    <thead>
      <tr style="background-color: #2F3E46; color: white;">
        <th style="border: 1px solid #ddd; padding: 12px; text-align: left;">Agent Name</th>
        <th style="border: 1px solid #ddd; padding: 12px; text-align: right;">Monthly Cap</th>
        <th style="border: 1px solid #ddd; padding: 12px; text-align: right;">MTD Spend</th>
        <th style="border: 1px solid #ddd; padding: 12px; text-align: right;">Daily Burn</th>
        <th style="border: 1px solid #ddd; padding: 12px; text-align: center;">Days Until Cap</th>
      </tr>
    </thead>
    <tbody>
      ${rows.length > 0 ? rows : `<tr><td colspan="5" style="border: 1px solid #ddd; padding: 8px; text-align: center;">No active agents found.</td></tr>`}
    </tbody>
  </table>
  
  <p style="margin-top: 24px; font-size: 12px; color: #666; border-top: 1px solid #eee; padding-top: 8px;">
    This is an automated digest generated by the Paperclip Control Plane.
  </p>
</body>
</html>
`.trim();

  return { subject, body };
}

/**
 * Saves Outlook draft to local storage.
 */
export function saveOutlookDraft(subject: string, body: string, generatedAt: string): string {
  const vaultDir = path.resolve(process.cwd(), "vault", "outlook");
  if (!fs.existsSync(vaultDir)) {
    fs.mkdirSync(vaultDir, { recursive: true });
  }

  const filename = `draft_${new Date(generatedAt).getTime()}.json`;
  const draftPath = path.join(vaultDir, filename);

  const draftData = {
    subject,
    body,
    to: "ivan@example.com",
    status: "drafted",
    createdAt: generatedAt,
  };

  fs.writeFileSync(draftPath, JSON.stringify(draftData, null, 2), "utf-8");
  return draftPath;
}

export type SlackDispatchOutcome = "sent" | "disabled" | "failed";

/**
 * Dispatches the Slack body.
 */
export async function dispatchSlackMessage(
  url: string | null | undefined,
  text: string,
): Promise<SlackDispatchOutcome> {
  if (!url) {
    logger.info("Slack dispatcher is disabled (no webhook URL)");
    return "disabled";
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (response.ok) {
      logger.info("Slack economics digest delivered successfully");
      return "sent";
    }

    logger.warn({ status: response.status }, "Slack economics digest delivery failed");
    return "failed";
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, "Slack dispatcher crashed");
    return "failed";
  }
}

/**
 * Orchestrates compiling, dispatching Slack, and saving Outlook draft for a given company.
 */
export async function executeEconomicsDigest(
  db: Db,
  companyId: string,
  now: Date = new Date(),
  slackWebhookUrl?: string | null,
): Promise<EconomicsDigest> {
  logger.info({ companyId }, "starting weekly economics digest compilation");
  
  const digest = await buildEconomicsDigest(db, companyId, now);
  
  // 1. Post to Slack
  const slackText = renderEconomicsDigestSlack(digest);
  const slackUrl = slackWebhookUrl ?? process.env.PAPERCLIP_OPS_ECONOMICS_DIGEST_WEBHOOK_URL;
  const slackOutcome = await dispatchSlackMessage(slackUrl, slackText);

  // 2. Save Outlook Draft
  const outlookDraft = renderEconomicsDigestOutlook(digest);
  const draftPath = saveOutlookDraft(outlookDraft.subject, outlookDraft.body, digest.generatedAt);
  
  logger.info(
    {
      companyId,
      slackOutcome,
      outlookDraftPath: draftPath,
    },
    "weekly economics digest completed",
  );

  // 3. Log Activity
  await logActivity(db as any, {
    companyId,
    actorType: "system",
    actorId: "system",
    agentId: null,
    action: "economics_digest.generated",
    entityType: "company",
    entityId: companyId,
    details: {
      slackOutcome,
      outlookDraftPath: draftPath,
      agentCount: digest.agents.length,
    },
  });

  return digest;
}
