import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  rt2CareerProfiles,
  rt2CareerPortfolio,
  rt2SkillTransfers,
  rt2CareerMilestones,
} from "@paperclipai/db";

export type CareerProfile = {
  id: string;
  companyId: string;
  agentId: string;
  name: string;
  title: string | null;
  summary: string | null;
  skills: string[];
  certifications: string[];
  totalTasksCompleted: number;
  totalProjectsDelivered: number;
  averageQualityScore: number;
  yearsOfExperience: number;
  isPublic: boolean;
  portableData: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CareerPortfolioEntry = {
  id: string;
  careerProfileId: string;
  companyId: string;
  workProductId: string | null;
  title: string;
  description: string | null;
  category: string;
  tags: string[];
  qualityScore: number;
  complexityLevel: string;
  impactSummary: string | null;
  evidenceUrls: string[];
  displayOrder: number;
  isFeatured: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type SkillTransfer = {
  id: string;
  companyId: string;
  transferType: string;
  sourceProfileId: string | null;
  sourceCompanyId: string | null;
  destProfileId: string | null;
  destCompanyId: string | null;
  skills: string[];
  transferReason: string | null;
  status: string;
  completedAt: Date | null;
  expiresAt: Date | null;
  verificationScore: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CareerMilestone = {
  id: string;
  careerProfileId: string;
  companyId: string;
  title: string;
  description: string | null;
  category: string;
  achievedAt: Date | null;
  evidenceUrls: string[];
  impactMetrics: Record<string, unknown> | null;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

export function rt2CareerMateService(db: Db) {
  // ===== Career Profiles =====

  /**
   * M3.3: Create or update career profile for an agent
   */
  async function upsertCareerProfile(
    companyId: string,
    agentId: string,
    data: {
      name: string;
      title?: string;
      summary?: string;
      skills?: string[];
      certifications?: string[];
      yearsOfExperience?: number;
    },
  ): Promise<CareerProfile> {
    const existing = await db
      .select()
      .from(rt2CareerProfiles)
      .where(
        and(
          eq(rt2CareerProfiles.companyId, companyId),
          eq(rt2CareerProfiles.agentId, agentId),
        ),
      )
      .limit(1);

    if (existing[0]) {
      const [updated] = await db
        .update(rt2CareerProfiles)
        .set({
          name: data.name,
          title: data.title ?? existing[0].title,
          summary: data.summary ?? existing[0].summary,
          skills: data.skills ?? existing[0].skills as string[],
          certifications: data.certifications ?? existing[0].certifications as string[],
          yearsOfExperience: data.yearsOfExperience ?? existing[0].yearsOfExperience,
          updatedAt: new Date(),
        })
        .where(eq(rt2CareerProfiles.id, existing[0].id))
        .returning();

      return {
        ...updated,
        skills: updated.skills as string[],
        certifications: updated.certifications as string[],
      } as CareerProfile;
    }

    const [created] = await db
      .insert(rt2CareerProfiles)
      .values({
        companyId,
        agentId,
        name: data.name,
        title: data.title ?? null,
        summary: data.summary ?? null,
        skills: data.skills ?? [],
        certifications: data.certifications ?? [],
        yearsOfExperience: data.yearsOfExperience ?? 0,
      })
      .returning();

    return {
      ...created,
      skills: created.skills as string[],
      certifications: created.certifications as string[],
    } as CareerProfile;
  }

  /**
   * M3.3: Get career profile by agent
   */
  async function getCareerProfileByAgent(
    companyId: string,
    agentId: string,
  ): Promise<CareerProfile | null> {
    const [profile] = await db
      .select()
      .from(rt2CareerProfiles)
      .where(
        and(
          eq(rt2CareerProfiles.companyId, companyId),
          eq(rt2CareerProfiles.agentId, agentId),
        ),
      )
      .limit(1);

    if (!profile) return null;

    return {
      ...profile,
      skills: profile.skills as string[],
      certifications: profile.certifications as string[],
    } as CareerProfile;
  }

  /**
   * M3.3: Get public career profiles
   */
  async function getPublicProfiles(limit: number = 20): Promise<CareerProfile[]> {
    const profiles = await db
      .select()
      .from(rt2CareerProfiles)
      .where(eq(rt2CareerProfiles.isPublic, true))
      .orderBy(desc(rt2CareerProfiles.averageQualityScore))
      .limit(limit);

    return profiles.map(p => ({
      ...p,
      skills: p.skills as string[],
      certifications: p.certifications as string[],
    })) as CareerProfile[];
  }

  /**
   * M3.3: Update career stats from task completion
   */
  async function updateCareerStats(
    profileId: string,
    qualityScore: number,
  ): Promise<void> {
    const profile = await db
      .select()
      .from(rt2CareerProfiles)
      .where(eq(rt2CareerProfiles.id, profileId))
      .limit(1);

    if (!profile[0]) return;

    const newTotal = profile[0].totalTasksCompleted + 1;
    const currentAvg = profile[0].averageQualityScore;
    const newAvg = Math.round(
      (currentAvg * profile[0].totalTasksCompleted + qualityScore) / newTotal,
    );

    await db
      .update(rt2CareerProfiles)
      .set({
        totalTasksCompleted: sql`${rt2CareerProfiles.totalTasksCompleted} + 1`,
        averageQualityScore: newAvg,
        updatedAt: new Date(),
      })
      .where(eq(rt2CareerProfiles.id, profileId));
  }

  /**
   * M3.3: Export portable career data
   */
  async function exportPortableData(profileId: string): Promise<Record<string, unknown> | null> {
    const profile = await db
      .select()
      .from(rt2CareerProfiles)
      .where(eq(rt2CareerProfiles.id, profileId))
      .limit(1);

    if (!profile[0]) return null;

    const portfolio = await db
      .select()
      .from(rt2CareerPortfolio)
      .where(eq(rt2CareerPortfolio.careerProfileId, profileId))
      .orderBy(rt2CareerPortfolio.displayOrder);

    const milestones = await db
      .select()
      .from(rt2CareerMilestones)
      .where(eq(rt2CareerMilestones.careerProfileId, profileId))
      .orderBy(rt2CareerMilestones.displayOrder);

    const portableData = {
      profile: {
        name: profile[0].name,
        title: profile[0].title,
        summary: profile[0].summary,
        skills: profile[0].skills,
        certifications: profile[0].certifications,
        yearsOfExperience: profile[0].yearsOfExperience,
        stats: {
          tasksCompleted: profile[0].totalTasksCompleted,
          projectsDelivered: profile[0].totalProjectsDelivered,
          averageQualityScore: profile[0].averageQualityScore,
        },
      },
      portfolio: portfolio.map(p => ({
        title: p.title,
        description: p.description,
        category: p.category,
        tags: p.tags,
        qualityScore: p.qualityScore,
        complexityLevel: p.complexityLevel,
        impactSummary: p.impactSummary,
        evidenceUrls: p.evidenceUrls,
      })),
      milestones: milestones.map(m => ({
        title: m.title,
        description: m.description,
        category: m.category,
        achievedAt: m.achievedAt,
        evidenceUrls: m.evidenceUrls,
      })),
      exportedAt: new Date().toISOString(),
    };

    // Update portable data in profile
    await db
      .update(rt2CareerProfiles)
      .set({
        portableData: portableData as any,
        updatedAt: new Date(),
      })
      .where(eq(rt2CareerProfiles.id, profileId));

    return portableData;
  }

  // ===== Career Portfolio =====

  /**
   * M3.3: Add work product to career portfolio
   */
  async function addToPortfolio(
    careerProfileId: string,
    companyId: string,
    data: {
      workProductId?: string;
      title: string;
      description?: string;
      category: string;
      tags?: string[];
      qualityScore?: number;
      complexityLevel?: string;
      impactSummary?: string;
      evidenceUrls?: string[];
    },
  ): Promise<CareerPortfolioEntry> {
    const [entry] = await db
      .insert(rt2CareerPortfolio)
      .values({
        careerProfileId,
        companyId,
        workProductId: data.workProductId ?? null,
        title: data.title,
        description: data.description ?? null,
        category: data.category,
        tags: data.tags ?? [],
        qualityScore: data.qualityScore ?? 0,
        complexityLevel: data.complexityLevel ?? "medium",
        impactSummary: data.impactSummary ?? null,
        evidenceUrls: data.evidenceUrls ?? [],
      })
      .returning();

    return {
      ...entry,
      tags: entry.tags as string[],
      evidenceUrls: entry.evidenceUrls as string[],
    } as CareerPortfolioEntry;
  }

  /**
   * M3.3: Get portfolio entries for a career profile
   */
  async function getPortfolioEntries(
    careerProfileId: string,
    options?: {
      category?: string;
      featured?: boolean;
    },
  ): Promise<CareerPortfolioEntry[]> {
    const conditions = [eq(rt2CareerPortfolio.careerProfileId, careerProfileId)];

    if (options?.category) {
      conditions.push(eq(rt2CareerPortfolio.category, options.category));
    }
    if (options?.featured !== undefined) {
      conditions.push(eq(rt2CareerPortfolio.isFeatured, options.featured));
    }

    const entries = await db
      .select()
      .from(rt2CareerPortfolio)
      .where(and(...conditions))
      .orderBy(rt2CareerPortfolio.displayOrder);

    return entries.map(e => ({
      ...e,
      tags: e.tags as string[],
      evidenceUrls: e.evidenceUrls as string[],
    })) as CareerPortfolioEntry[];
  }

  /**
   * M3.3: Update portfolio entry
   */
  async function updatePortfolioEntry(
    entryId: string,
    data: Partial<{
      title: string;
      description: string;
      tags: string[];
      qualityScore: number;
      complexityLevel: string;
      impactSummary: string;
      evidenceUrls: string[];
      displayOrder: number;
      isFeatured: boolean;
    }>,
  ): Promise<CareerPortfolioEntry> {
    const [updated] = await db
      .update(rt2CareerPortfolio)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(rt2CareerPortfolio.id, entryId))
      .returning();

    return {
      ...updated,
      tags: updated.tags as string[],
      evidenceUrls: updated.evidenceUrls as string[],
    } as CareerPortfolioEntry;
  }

  // ===== Skill Transfers =====

  /**
   * M3.3: Export skills from profile
   */
  async function exportSkills(
    companyId: string,
    profileId: string,
    skills: string[],
    destCompanyId?: string,
  ): Promise<SkillTransfer> {
    const [transfer] = await db
      .insert(rt2SkillTransfers)
      .values({
        companyId,
        transferType: "export",
        sourceProfileId: profileId,
        destCompanyId: destCompanyId ?? null,
        skills,
        status: "pending",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      })
      .returning();

    return transfer as unknown as SkillTransfer;
  }

  /**
   * M3.3: Import skills to profile
   */
  async function importSkills(
    companyId: string,
    profileId: string,
    skills: string[],
    sourceCompanyId?: string,
  ): Promise<SkillTransfer> {
    const [transfer] = await db
      .insert(rt2SkillTransfers)
      .values({
        companyId,
        transferType: "import",
        destProfileId: profileId,
        sourceCompanyId: sourceCompanyId ?? null,
        skills,
        status: "pending",
      })
      .returning();

    return transfer as unknown as SkillTransfer;
  }

  /**
   * M3.3: Share skills between profiles
   */
  async function shareSkills(
    companyId: string,
    sourceProfileId: string,
    destProfileId: string,
    skills: string[],
    reason?: string,
  ): Promise<SkillTransfer> {
    const [transfer] = await db
      .insert(rt2SkillTransfers)
      .values({
        companyId,
        transferType: "share",
        sourceProfileId,
        destProfileId,
        skills,
        transferReason: reason ?? null,
        status: "completed",
        completedAt: new Date(),
      })
      .returning();

    // Apply skills to destination profile
    const destProfile = await db
      .select()
      .from(rt2CareerProfiles)
      .where(eq(rt2CareerProfiles.id, destProfileId))
      .limit(1);

    if (destProfile[0]) {
      const existingSkills = destProfile[0].skills as string[];
      const newSkills = [...new Set([...existingSkills, ...skills])];

      await db
        .update(rt2CareerProfiles)
        .set({
          skills: newSkills,
          updatedAt: new Date(),
        })
        .where(eq(rt2CareerProfiles.id, destProfileId));
    }

    return transfer as unknown as SkillTransfer;
  }

  /**
   * M3.3: Complete skill transfer
   */
  async function completeSkillTransfer(transferId: string): Promise<SkillTransfer> {
    const [updated] = await db
      .update(rt2SkillTransfers)
      .set({
        status: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(rt2SkillTransfers.id, transferId))
      .returning();

    return updated as unknown as SkillTransfer;
  }

  /**
   * M3.3: Get skill transfers for a profile
   */
  async function getSkillTransfers(
    profileId: string,
  ): Promise<SkillTransfer[]> {
    const transfers = await db
      .select()
      .from(rt2SkillTransfers)
      .where(
        sql`${rt2SkillTransfers.sourceProfileId} = ${profileId} OR ${rt2SkillTransfers.destProfileId} = ${profileId}`,
      )
      .orderBy(desc(rt2SkillTransfers.createdAt));

    return transfers as unknown as SkillTransfer[];
  }

  // ===== Career Milestones =====

  /**
   * M3.3: Add career milestone
   */
  async function addMilestone(
    careerProfileId: string,
    companyId: string,
    data: {
      title: string;
      description?: string;
      category: string;
      achievedAt?: Date;
      evidenceUrls?: string[];
      impactMetrics?: Record<string, unknown>;
    },
  ): Promise<CareerMilestone> {
    const [milestone] = await db
      .insert(rt2CareerMilestones)
      .values({
        careerProfileId,
        companyId,
        title: data.title,
        description: data.description ?? null,
        category: data.category,
        achievedAt: data.achievedAt ?? null,
        evidenceUrls: data.evidenceUrls ?? [],
        impactMetrics: data.impactMetrics ?? null,
      })
      .returning();

    return {
      ...milestone,
      evidenceUrls: milestone.evidenceUrls as string[],
    } as CareerMilestone;
  }

  /**
   * M3.3: Get milestones for a career profile
   */
  async function getMilestones(
    careerProfileId: string,
  ): Promise<CareerMilestone[]> {
    const milestones = await db
      .select()
      .from(rt2CareerMilestones)
      .where(eq(rt2CareerMilestones.careerProfileId, careerProfileId))
      .orderBy(rt2CareerMilestones.displayOrder);

    return milestones.map(m => ({
      ...m,
      evidenceUrls: m.evidenceUrls as string[],
    })) as CareerMilestone[];
  }

  return {
    // Career Profiles
    upsertCareerProfile,
    getCareerProfileByAgent,
    getPublicProfiles,
    updateCareerStats,
    exportPortableData,
    // Portfolio
    addToPortfolio,
    getPortfolioEntries,
    updatePortfolioEntry,
    // Skill Transfers
    exportSkills,
    importSkills,
    shareSkills,
    completeSkillTransfer,
    getSkillTransfers,
    // Milestones
    addMilestone,
    getMilestones,
  };
}