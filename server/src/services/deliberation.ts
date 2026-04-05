import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import {
  channelDeliberations,
  channelDeliberationPositions,
  channelDeliberationRebuttals,
  agents,
  channelMessages,
} from "@ironworksai/db";
import { logger } from "../middleware/logger.js";

// ── Deliberation Protocol ─────────────────────────────────────────────────
//
// Structured multi-agent discussion mode for channels. When triggered,
// agents take turns presenting positions with evidence, rebuttals,
// and a final synthesis.

export interface DeliberationSummary {
  id: string;
  companyId: string;
  channelId: string;
  topic: string;
  status: string;
  synthesisText: string | null;
  createdAt: Date;
  updatedAt: Date;
  positions: Array<{
    id: string;
    agentId: string;
    agentName: string | null;
    positionText: string;
    evidenceText: string | null;
    createdAt: Date;
    rebuttals: Array<{
      id: string;
      agentId: string;
      agentName: string | null;
      rebuttalText: string;
      createdAt: Date;
    }>;
  }>;
}

/**
 * Start a new deliberation in a channel. Creates the deliberation record
 * and posts an announcement message.
 */
export async function startDeliberationProtocol(
  db: Db,
  channelId: string,
  companyId: string,
  topic: string,
  participantAgentIds: string[],
): Promise<string> {
  const [deliberation] = await db
    .insert(channelDeliberations)
    .values({
      companyId,
      channelId,
      topic,
      status: "open",
    })
    .returning();

  // Fetch participant names for the announcement
  const agentRows = participantAgentIds.length > 0
    ? await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
          ),
        )
        .then((rows) => rows.filter((r) => participantAgentIds.includes(r.id)))
    : [];

  const participantNames = agentRows.map((a) => `@${a.name}`).join(", ");

  // Post announcement to channel
  await db.insert(channelMessages).values({
    channelId,
    companyId,
    authorAgentId: null,
    authorUserId: null,
    body: `[DELIBERATION STARTED] Topic: ${topic}\n\nParticipants: ${participantNames || "All channel members"}\nPlease submit your positions with evidence.`,
    messageType: "deliberation",
    mentions: participantAgentIds,
    reasoning: JSON.stringify({ deliberationId: deliberation.id }),
  });

  logger.info(
    { deliberationId: deliberation.id, channelId, topic, participants: participantAgentIds.length },
    "deliberation started",
  );

  return deliberation.id;
}

/**
 * Agent submits a position in an open deliberation.
 */
export async function addPosition(
  db: Db,
  deliberationId: string,
  agentId: string,
  position: string,
  evidence: string | null,
): Promise<string> {
  // Verify deliberation is open
  const [deliberation] = await db
    .select()
    .from(channelDeliberations)
    .where(eq(channelDeliberations.id, deliberationId))
    .limit(1);

  if (!deliberation) throw new Error("Deliberation not found");
  if (deliberation.status !== "open") throw new Error("Deliberation is not open for positions");

  const [positionRow] = await db
    .insert(channelDeliberationPositions)
    .values({
      deliberationId,
      agentId,
      positionText: position,
      evidenceText: evidence,
    })
    .returning();

  // Post to channel as a reply context
  const [agentRow] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const agentName = agentRow?.name ?? "Agent";
  const evidenceNote = evidence ? `\n\nEvidence: ${evidence}` : "";

  await db.insert(channelMessages).values({
    channelId: deliberation.channelId,
    companyId: deliberation.companyId,
    authorAgentId: agentId,
    body: `[POSITION on "${deliberation.topic}"] ${position}${evidenceNote}`,
    messageType: "deliberation",
    mentions: [],
  });

  logger.info(
    { deliberationId, agentId, agentName },
    "position added to deliberation",
  );

  return positionRow.id;
}

/**
 * Agent submits a rebuttal targeting a specific position.
 */
export async function addRebuttal(
  db: Db,
  deliberationId: string,
  agentId: string,
  targetPositionId: string,
  rebuttal: string,
): Promise<string> {
  // Verify deliberation is open
  const [deliberation] = await db
    .select()
    .from(channelDeliberations)
    .where(eq(channelDeliberations.id, deliberationId))
    .limit(1);

  if (!deliberation) throw new Error("Deliberation not found");
  if (deliberation.status !== "open") throw new Error("Deliberation is not open for rebuttals");

  // Verify target position exists
  const [targetPosition] = await db
    .select({ agentId: channelDeliberationPositions.agentId })
    .from(channelDeliberationPositions)
    .where(eq(channelDeliberationPositions.id, targetPositionId))
    .limit(1);

  if (!targetPosition) throw new Error("Target position not found");

  const [rebuttalRow] = await db
    .insert(channelDeliberationRebuttals)
    .values({
      deliberationId,
      agentId,
      targetPositionId,
      rebuttalText: rebuttal,
    })
    .returning();

  // Post to channel
  const [agentRow] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const [targetAgentRow] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, targetPosition.agentId))
    .limit(1);

  const agentName = agentRow?.name ?? "Agent";
  const targetName = targetAgentRow?.name ?? "Agent";

  await db.insert(channelMessages).values({
    channelId: deliberation.channelId,
    companyId: deliberation.companyId,
    authorAgentId: agentId,
    body: `[REBUTTAL to ${targetName}'s position on "${deliberation.topic}"] ${rebuttal}`,
    messageType: "deliberation",
    mentions: [targetPosition.agentId],
  });

  logger.info(
    { deliberationId, agentId, agentName, targetPositionId },
    "rebuttal added to deliberation",
  );

  return rebuttalRow.id;
}

/**
 * Synthesize all positions and rebuttals into a summary.
 * Closes the deliberation and posts the synthesis to the channel.
 */
export async function synthesize(
  db: Db,
  deliberationId: string,
): Promise<string> {
  const [deliberation] = await db
    .select()
    .from(channelDeliberations)
    .where(eq(channelDeliberations.id, deliberationId))
    .limit(1);

  if (!deliberation) throw new Error("Deliberation not found");

  // Fetch all positions with agent names
  const positions = await db
    .select({
      id: channelDeliberationPositions.id,
      agentId: channelDeliberationPositions.agentId,
      positionText: channelDeliberationPositions.positionText,
      evidenceText: channelDeliberationPositions.evidenceText,
      createdAt: channelDeliberationPositions.createdAt,
    })
    .from(channelDeliberationPositions)
    .where(eq(channelDeliberationPositions.deliberationId, deliberationId))
    .orderBy(asc(channelDeliberationPositions.createdAt));

  // Fetch all rebuttals
  const rebuttals = await db
    .select({
      id: channelDeliberationRebuttals.id,
      agentId: channelDeliberationRebuttals.agentId,
      targetPositionId: channelDeliberationRebuttals.targetPositionId,
      rebuttalText: channelDeliberationRebuttals.rebuttalText,
      createdAt: channelDeliberationRebuttals.createdAt,
    })
    .from(channelDeliberationRebuttals)
    .where(eq(channelDeliberationRebuttals.deliberationId, deliberationId))
    .orderBy(asc(channelDeliberationRebuttals.createdAt));

  // Fetch agent names
  const allAgentIds = [
    ...new Set([
      ...positions.map((p) => p.agentId),
      ...rebuttals.map((r) => r.agentId),
    ]),
  ];
  const agentRows = allAgentIds.length > 0
    ? await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .then((rows) => rows.filter((r) => allAgentIds.includes(r.id)))
    : [];
  const agentNameMap = new Map(agentRows.map((a) => [a.id, a.name]));

  // Build synthesis text
  const lines: string[] = [];
  lines.push(`# Deliberation Synthesis: ${deliberation.topic}`);
  lines.push("");
  lines.push(`**Participants:** ${positions.length} positions, ${rebuttals.length} rebuttals`);
  lines.push("");

  for (const pos of positions) {
    const name = agentNameMap.get(pos.agentId) ?? "Unknown Agent";
    lines.push(`## Position by ${name}`);
    lines.push(pos.positionText);
    if (pos.evidenceText) {
      lines.push(`\n**Evidence:** ${pos.evidenceText}`);
    }

    // Attach rebuttals to this position
    const posRebuttals = rebuttals.filter((r) => r.targetPositionId === pos.id);
    if (posRebuttals.length > 0) {
      lines.push("\n**Rebuttals:**");
      for (const reb of posRebuttals) {
        const rebName = agentNameMap.get(reb.agentId) ?? "Unknown Agent";
        lines.push(`- ${rebName}: ${reb.rebuttalText}`);
      }
    }
    lines.push("");
  }

  // Key themes / consensus
  const uniqueAgentPositions = positions.length;
  if (uniqueAgentPositions <= 1) {
    lines.push("## Consensus");
    lines.push("Only one position was presented. Proceeding with that approach.");
  } else if (rebuttals.length === 0) {
    lines.push("## Consensus");
    lines.push("Multiple positions were presented with no rebuttals. All approaches appear viable.");
  } else {
    lines.push("## Areas of Disagreement");
    lines.push(`${rebuttals.length} rebuttal(s) were raised across ${uniqueAgentPositions} positions. Further discussion may be needed to reach alignment.`);
  }

  const synthesisText = lines.join("\n");

  // Update deliberation record
  await db
    .update(channelDeliberations)
    .set({
      status: "synthesized",
      synthesisText,
      updatedAt: new Date(),
    })
    .where(eq(channelDeliberations.id, deliberationId));

  // Post synthesis to channel
  await db.insert(channelMessages).values({
    channelId: deliberation.channelId,
    companyId: deliberation.companyId,
    authorAgentId: null,
    authorUserId: null,
    body: `[DELIBERATION SYNTHESIS]\n\n${synthesisText}`,
    messageType: "deliberation",
    mentions: [],
    reasoning: JSON.stringify({ deliberationId }),
  });

  logger.info(
    { deliberationId, positionCount: positions.length, rebuttalCount: rebuttals.length },
    "deliberation synthesized",
  );

  return synthesisText;
}

/**
 * Fetch a full deliberation with all positions and rebuttals.
 */
export async function getDeliberation(
  db: Db,
  deliberationId: string,
): Promise<DeliberationSummary | null> {
  const [deliberation] = await db
    .select()
    .from(channelDeliberations)
    .where(eq(channelDeliberations.id, deliberationId))
    .limit(1);

  if (!deliberation) return null;

  const positions = await db
    .select({
      id: channelDeliberationPositions.id,
      agentId: channelDeliberationPositions.agentId,
      positionText: channelDeliberationPositions.positionText,
      evidenceText: channelDeliberationPositions.evidenceText,
      createdAt: channelDeliberationPositions.createdAt,
    })
    .from(channelDeliberationPositions)
    .where(eq(channelDeliberationPositions.deliberationId, deliberationId))
    .orderBy(asc(channelDeliberationPositions.createdAt));

  const rebuttals = await db
    .select({
      id: channelDeliberationRebuttals.id,
      agentId: channelDeliberationRebuttals.agentId,
      targetPositionId: channelDeliberationRebuttals.targetPositionId,
      rebuttalText: channelDeliberationRebuttals.rebuttalText,
      createdAt: channelDeliberationRebuttals.createdAt,
    })
    .from(channelDeliberationRebuttals)
    .where(eq(channelDeliberationRebuttals.deliberationId, deliberationId))
    .orderBy(asc(channelDeliberationRebuttals.createdAt));

  // Fetch all agent names
  const allAgentIds = [
    ...new Set([
      ...positions.map((p) => p.agentId),
      ...rebuttals.map((r) => r.agentId),
    ]),
  ];
  const agentRows = allAgentIds.length > 0
    ? await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .then((rows) => rows.filter((r) => allAgentIds.includes(r.id)))
    : [];
  const agentNameMap = new Map(agentRows.map((a) => [a.id, a.name]));

  return {
    id: deliberation.id,
    companyId: deliberation.companyId,
    channelId: deliberation.channelId,
    topic: deliberation.topic,
    status: deliberation.status,
    synthesisText: deliberation.synthesisText,
    createdAt: deliberation.createdAt,
    updatedAt: deliberation.updatedAt,
    positions: positions.map((p) => ({
      id: p.id,
      agentId: p.agentId,
      agentName: agentNameMap.get(p.agentId) ?? null,
      positionText: p.positionText,
      evidenceText: p.evidenceText,
      createdAt: p.createdAt,
      rebuttals: rebuttals
        .filter((r) => r.targetPositionId === p.id)
        .map((r) => ({
          id: r.id,
          agentId: r.agentId,
          agentName: agentNameMap.get(r.agentId) ?? null,
          rebuttalText: r.rebuttalText,
          createdAt: r.createdAt,
        })),
    })),
  };
}
