import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueWorkProducts,
  rt2CollaborationEvents,
  rt2CollaborationRewards,
  rt2QualityScores,
  rt2V33TaskParticipants,
  rt2V33TaskProfiles,
} from "@paperclipai/db";

export type CollaborationReward = {
  id: string;
  companyId: string;
  actorId: string;
  actorType: "user" | "agent";
  reputationIndex: number;
  multiplier: number;
  aiContributionScore: number;
  totalCollaborations: number;
  successfulCollaborations: number;
};

export type CollaborationEvent = {
  id: string;
  companyId: string;
  actorId: string;
  actorType: "user" | "agent";
  workProductId: string | null;
  collaborationType: "peer_review" | "pair_work" | "knowledge_sharing" | "help_provided";
  successful: "pending" | "yes" | "no";
  pointsEarned: number;
  reputationChange: number;
  description: string | null;
  createdAt: Date;
};

// Multiplier tiers based on reputation
const MULTIPLIER_TIERS = [
  { minRep: 900, multiplier: 1.5 },
  { minRep: 700, multiplier: 1.3 },
  { minRep: 500, multiplier: 1.1 },
  { minRep: 300, multiplier: 0.9 },
  { minRep: 0, multiplier: 0.7 },
];

function calculateMultiplier(reputationIndex: number): number {
  for (const tier of MULTIPLIER_TIERS) {
    if (reputationIndex >= tier.minRep) {
      return tier.multiplier;
    }
  }
  return 0.7;
}

// AI contribution scoring
const AI_CONTRIBUTION_POINTS = {
  completed: 10,
  helped: 5,
  reviewed: 3,
};

export function rt2CollaborationRewardsService(db: Db) {
  /**
   * M2.6: Get or create reward record for an actor
   */
  async function getOrCreateReward(
    companyId: string,
    actorId: string,
    actorType: "user" | "agent",
  ): Promise<CollaborationReward> {
    const existing = await db
      .select()
      .from(rt2CollaborationRewards)
      .where(
        and(
          eq(rt2CollaborationRewards.companyId, companyId),
          eq(rt2CollaborationRewards.actorId, actorId),
          eq(rt2CollaborationRewards.actorType, actorType),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      return existing as CollaborationReward;
    }

    // Create new reward record
    const [created] = await db
      .insert(rt2CollaborationRewards)
      .values({
        companyId,
        actorId,
        actorType,
        reputationIndex: 500, // Start at middle
        multiplier: 1.0,
        aiContributionScore: 0,
        totalCollaborations: 0,
        successfulCollaborations: 0,
      })
      .returning();

    return created as CollaborationReward;
  }

  /**
   * M2.6: Get all rewards for a company
   */
  async function getCompanyRewards(companyId: string): Promise<CollaborationReward[]> {
    await deriveCollaborationRewardsFromEvidence(companyId);

    const rewards = await db
      .select()
      .from(rt2CollaborationRewards)
      .where(eq(rt2CollaborationRewards.companyId, companyId))
      .orderBy(desc(rt2CollaborationRewards.reputationIndex));
    return rewards.map(r => ({
      ...r,
      actorType: r.actorType as "user" | "agent",
    }));
  }

  /**
   * M2.6: Get rewards leaderboard (top reputation)
   */
  async function getRewardsLeaderboard(
    companyId: string,
    limit: number = 10,
  ): Promise<CollaborationReward[]> {
    await deriveCollaborationRewardsFromEvidence(companyId);

    const rewards = await db
      .select()
      .from(rt2CollaborationRewards)
      .where(eq(rt2CollaborationRewards.companyId, companyId))
      .orderBy(desc(rt2CollaborationRewards.reputationIndex))
      .limit(limit);
    return rewards.map(r => ({
      ...r,
      actorType: r.actorType as "user" | "agent",
    }));
  }

  /**
   * M2.6: Record a collaboration event and update rewards
   */
  async function recordCollaborationEvent(
    companyId: string,
    actorId: string,
    actorType: "user" | "agent",
    collaborationType: CollaborationEvent["collaborationType"],
    description: string,
    workProductId?: string,
  ): Promise<{ event: CollaborationEvent; updatedReward: CollaborationReward }> {
    // Get current reward
    const reward = await getOrCreateReward(companyId, actorId, actorType);

    // Calculate points based on collaboration type
    let pointsEarned = 0;
    switch (collaborationType) {
      case "peer_review":
        pointsEarned = 5;
        break;
      case "pair_work":
        pointsEarned = 10;
        break;
      case "knowledge_sharing":
        pointsEarned = 3;
        break;
      case "help_provided":
        pointsEarned = 7;
        break;
    }

    // Create event
    const [event] = await db
      .insert(rt2CollaborationEvents)
      .values({
        companyId,
        actorId,
        actorType,
        workProductId: workProductId ?? null,
        collaborationType,
        successful: "pending",
        pointsEarned,
        reputationChange: 0,
        description,
      })
      .returning();

    return {
      event: event as CollaborationEvent,
      updatedReward: reward,
    };
  }

  /**
   * M2.6: Confirm a collaboration (marks as successful and updates rewards)
   */
  async function confirmCollaboration(
    companyId: string,
    eventId: string,
    successful: boolean,
  ): Promise<CollaborationReward> {
    // Get the event
    const event = await db
      .select()
      .from(rt2CollaborationEvents)
      .where(
        and(
          eq(rt2CollaborationEvents.id, eventId),
          eq(rt2CollaborationEvents.companyId, companyId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!event) {
      throw new Error("Collaboration event not found");
    }

    // Calculate reputation change
    const baseChange = successful ? 10 : -5;
    const reputationChange = Math.round(baseChange * (event.actorType === "agent" ? 0.5 : 1));

    // Update event
    await db
      .update(rt2CollaborationEvents)
      .set({
        successful: successful ? "yes" : "no",
        reputationChange,
      })
      .where(eq(rt2CollaborationEvents.id, eventId));

    // Update reward
    const reward = await getOrCreateReward(companyId, event.actorId, event.actorType as "user" | "agent");
    const newReputation = Math.max(0, Math.min(1000, reward.reputationIndex + reputationChange));
    const newMultiplier = calculateMultiplier(newReputation);
    const newSuccessCount = successful ? reward.successfulCollaborations + 1 : reward.successfulCollaborations;

    await db
      .update(rt2CollaborationRewards)
      .set({
        reputationIndex: newReputation,
        multiplier: newMultiplier,
        totalCollaborations: reward.totalCollaborations + 1,
        successfulCollaborations: newSuccessCount,
        updatedAt: new Date(),
      })
      .where(eq(rt2CollaborationRewards.id, reward.id));

    return {
      ...reward,
      reputationIndex: newReputation,
      multiplier: newMultiplier,
      totalCollaborations: reward.totalCollaborations + 1,
      successfulCollaborations: newSuccessCount,
    };
  }

  /**
   * M2.6: Update AI contribution score
   */
  async function updateAiContributionScore(
    companyId: string,
    agentId: string,
    contributionType: keyof typeof AI_CONTRIBUTION_POINTS,
  ): Promise<CollaborationReward> {
    const reward = await getOrCreateReward(companyId, agentId, "agent");
    const points = AI_CONTRIBUTION_POINTS[contributionType];
    const newScore = Math.min(100, reward.aiContributionScore + points);

    await db
      .update(rt2CollaborationRewards)
      .set({
        aiContributionScore: newScore,
        updatedAt: new Date(),
      })
      .where(eq(rt2CollaborationRewards.id, reward.id));

    return {
      ...reward,
      aiContributionScore: newScore,
    };
  }

  /**
   * M2.6: Get collaboration events for an actor
   */
  async function getActorCollaborationHistory(
    companyId: string,
    actorId: string,
    limit: number = 20,
  ): Promise<CollaborationEvent[]> {
    await deriveCollaborationRewardsFromEvidence(companyId);

    const events = await db
      .select()
      .from(rt2CollaborationEvents)
      .where(
        and(
          eq(rt2CollaborationEvents.companyId, companyId),
          eq(rt2CollaborationEvents.actorId, actorId),
        ),
      )
      .orderBy(desc(rt2CollaborationEvents.createdAt))
      .limit(limit);

    return events.map(e => ({
      ...e,
      actorType: e.actorType as "user" | "agent",
      collaborationType: e.collaborationType as CollaborationEvent["collaborationType"],
      successful: e.successful as CollaborationEvent["successful"],
    }));
  }

  /**
   * M2.6: Get reputation statistics for a company
   */
  async function getReputationStats(companyId: string): Promise<{
    totalMembers: number;
    averageReputation: number;
    topMultiplier: number;
    aiAgentsCount: number;
  }> {
    const rewards = await getCompanyRewards(companyId);

    if (rewards.length === 0) {
      return {
        totalMembers: 0,
        averageReputation: 500,
        topMultiplier: 1.0,
        aiAgentsCount: 0,
      };
    }

    const totalReputation = rewards.reduce((sum, r) => sum + r.reputationIndex, 0);
    const averageReputation = Math.round(totalReputation / rewards.length);
    const topMultiplier = Math.max(...rewards.map((r) => r.multiplier));
    const aiAgentsCount = rewards.filter((r) => r.actorType === "agent").length;

    return {
      totalMembers: rewards.length,
      averageReputation,
      topMultiplier,
      aiAgentsCount,
    };
  }

  async function deriveCollaborationRewardsFromEvidence(companyId: string): Promise<{
    createdEvents: number;
    updatedRewards: number;
  }> {
    const rows = await db
      .select({
        taskIssueId: rt2V33TaskProfiles.issueId,
        taskMode: rt2V33TaskProfiles.taskMode,
        workProductId: issueWorkProducts.id,
        workProductTitle: issueWorkProducts.title,
        participantUserId: rt2V33TaskParticipants.userId,
        qualityScore: rt2QualityScores.score,
      })
      .from(rt2V33TaskProfiles)
      .innerJoin(
        rt2V33TaskParticipants,
        and(
          eq(rt2V33TaskParticipants.taskIssueId, rt2V33TaskProfiles.issueId),
          eq(rt2V33TaskParticipants.companyId, rt2V33TaskProfiles.companyId),
          eq(rt2V33TaskParticipants.state, "active"),
        ),
      )
      .innerJoin(
        issueWorkProducts,
        and(
          eq(issueWorkProducts.issueId, rt2V33TaskProfiles.issueId),
          eq(issueWorkProducts.companyId, rt2V33TaskProfiles.companyId),
        ),
      )
      .innerJoin(
        rt2QualityScores,
        and(
          eq(rt2QualityScores.taskIssueId, rt2V33TaskProfiles.issueId),
          eq(rt2QualityScores.companyId, rt2V33TaskProfiles.companyId),
          eq(rt2QualityScores.managerDecision, "approved"),
          eq(rt2QualityScores.isFinalized, 1),
          eq(rt2QualityScores.isActive, 1),
        ),
      )
      .where(and(eq(rt2V33TaskProfiles.companyId, companyId), eq(rt2V33TaskProfiles.taskMode, "collab")));

    let createdEvents = 0;
    let updatedRewards = 0;
    for (const row of rows) {
      const description = `Evidence-derived collaboration on ${row.workProductTitle} (${row.workProductId})`;
      const existing = await db
        .select({ id: rt2CollaborationEvents.id })
        .from(rt2CollaborationEvents)
        .where(
          and(
            eq(rt2CollaborationEvents.companyId, companyId),
            eq(rt2CollaborationEvents.actorId, row.participantUserId),
            eq(rt2CollaborationEvents.actorType, "user"),
            eq(rt2CollaborationEvents.collaborationType, "pair_work"),
            eq(rt2CollaborationEvents.description, description),
          ),
        )
        .limit(1);

      if (existing.length > 0) continue;

      const pointsEarned = Math.max(10, Math.round(row.qualityScore / 10));
      const reputationChange = Math.max(5, Math.round(row.qualityScore / 12));
      await db.insert(rt2CollaborationEvents).values({
        companyId,
        actorId: row.participantUserId,
        actorType: "user",
        workProductId: null,
        collaborationType: "pair_work",
        successful: "yes",
        pointsEarned,
        reputationChange,
        description,
      });
      createdEvents += 1;

      const reward = await getOrCreateReward(companyId, row.participantUserId, "user");
      const newReputation = Math.max(0, Math.min(1000, reward.reputationIndex + reputationChange));
      await db
        .update(rt2CollaborationRewards)
        .set({
          reputationIndex: newReputation,
          multiplier: calculateMultiplier(newReputation),
          totalCollaborations: reward.totalCollaborations + 1,
          successfulCollaborations: reward.successfulCollaborations + 1,
          updatedAt: new Date(),
        })
        .where(eq(rt2CollaborationRewards.id, reward.id));
      updatedRewards += 1;
    }

    return { createdEvents, updatedRewards };
  }

  return {
    getOrCreateReward,
    getCompanyRewards,
    getRewardsLeaderboard,
    recordCollaborationEvent,
    confirmCollaboration,
    updateAiContributionScore,
    getActorCollaborationHistory,
    getReputationStats,
    deriveCollaborationRewardsFromEvidence,
  };
}
