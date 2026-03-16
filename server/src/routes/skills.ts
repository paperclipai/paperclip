import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { skills, skillInstallations, skillReviews } from "@paperclipai/db";
import { eq, and, desc } from "drizzle-orm";
import { validate } from "../middleware/validate.js";
import { z } from "zod";
import { logger } from "../middleware/logger.js";
import { getSkillsService } from "../services/skills.js";
import { agentService } from "../services/index.js";

const installSkillSchema = z.object({
  skillId: z.string().uuid("Invalid skill ID"),
  agentId: z.string().uuid("Invalid agent ID").optional(),
});

const executeSkillSchema = z.object({
  skillName: z.string().min(1, "Skill name required"),
  inputData: z.record(z.unknown()).default({}),
});

const rateSkillSchema = z.object({
  rating: z.number().int().min(1).max(5),
  review: z.string().optional(),
});

export function skillsRoutes(db: Db) {
  const router = Router({ mergeParams: true });
  const skillsService = getSkillsService(db);
  const agentSvc = agentService(db);

  /**
   * GET /api/skills - List available skills
   */
  router.get("/", async (req, res) => {
    try {
      const category = (req.query as any).category as string | undefined;
      const search = (req.query as any).search as string | undefined;

      const availableSkills = await skillsService.getAvailableSkills(
        category,
        search
      );

      res.json({
        skills: availableSkills,
        total: availableSkills.length,
      });
    } catch (error: any) {
      logger.error(`Error listing skills: ${error?.message}`);
      res.status(500).json({ error: "Failed to list skills" });
    }
  });

  /**
   * GET /api/skills/:skillId - Get skill details
   */
  router.get("/:skillId", async (req, res) => {
    try {
      const skillId = (req.params as any).skillId as string;

      const skill = await db
        .select()
        .from(skills)
        .where(eq(skills.id, skillId))
        .then((rows) => rows[0] ?? null);

      if (!skill) {
        return res.status(404).json({ error: "Skill not found" });
      }

      res.json(skill);
    } catch (error: any) {
      logger.error(`Error getting skill: ${error?.message}`);
      res.status(500).json({ error: "Failed to get skill" });
    }
  });

  /**
   * POST /api/companies/:companyId/skills/install - Install skill
   */
  router.post(
    "/:companyId/skills/install",
    validate(installSkillSchema),
    async (req, res) => {
      try {
        const companyId = (req.params as any).companyId as string;
        const { skillId, agentId } = req.body;
        const userId = (req.actor as any).userId;

        // Verify company access
        const companies = (req.actor as any).companyIds || [];
        if (!companies.includes(companyId)) {
          return res.status(403).json({ error: "Access denied" });
        }

        // If agentId provided, verify it belongs to this company
        if (agentId) {
          const agent = await agentSvc.getById(agentId);
          if (!agent || agent.companyId !== companyId) {
            return res.status(404).json({ error: "Agent not found" });
          }
        }

        // Install skill
        const installation = await skillsService.installSkill(
          skillId,
          companyId,
          userId,
          agentId
        );

        if (!installation) {
          return res.status(400).json({ error: "Failed to install skill" });
        }

        logger.info(
          `Skill installed: ${skillId} for company ${companyId}`
        );

        res.status(201).json({
          message: "Skill installed successfully",
          installation,
        });
      } catch (error: any) {
        logger.error(`Error installing skill: ${error?.message}`);
        res.status(500).json({ error: "Failed to install skill" });
      }
    }
  );

  /**
   * DELETE /api/companies/:companyId/skills/:skillId - Uninstall skill
   */
  router.delete("/:companyId/skills/:skillId", async (req, res) => {
    try {
      const companyId = (req.params as any).companyId as string;
      const skillId = (req.params as any).skillId as string;
      const agentId = (req.query as any).agentId as string | undefined;

      // Verify company access
      const companies = (req.actor as any).companyIds || [];
      if (!companies.includes(companyId)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const success = await skillsService.uninstallSkill(
        skillId,
        companyId,
        agentId
      );

      if (!success) {
        return res.status(400).json({ error: "Failed to uninstall skill" });
      }

      logger.info(`Skill uninstalled: ${skillId}`);

      res.json({ success: true, message: "Skill uninstalled" });
    } catch (error: any) {
      logger.error(`Error uninstalling skill: ${error?.message}`);
      res.status(500).json({ error: "Failed to uninstall skill" });
    }
  });

  /**
   * GET /api/companies/:companyId/skills/installed - Get installed skills
   */
  router.get("/:companyId/skills/installed", async (req, res) => {
    try {
      const companyId = (req.params as any).companyId as string;
      const agentId = (req.query as any).agentId as string | undefined;

      // Verify company access
      const companies = (req.actor as any).companyIds || [];
      if (!companies.includes(companyId)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const installed = await skillsService.getInstalledSkills(
        companyId,
        agentId
      );

      res.json({
        skills: installed,
        total: installed.length,
      });
    } catch (error: any) {
      logger.error(`Error getting installed skills: ${error?.message}`);
      res.status(500).json({ error: "Failed to get installed skills" });
    }
  });

  /**
   * POST /api/agents/:agentId/skills/execute - Execute skill
   */
  router.post(
    "/:agentId/skills/execute",
    validate(executeSkillSchema),
    async (req, res) => {
      try {
        const agentId = (req.params as any).agentId as string;
        const { skillName, inputData } = req.body;

        // Verify agent exists and user has access
        const agent = await agentSvc.getById(agentId);
        if (!agent) {
          return res.status(404).json({ error: "Agent not found" });
        }

        // Verify company access
        const companies = (req.actor as any).companyIds || [];
        if (!companies.includes(agent.companyId)) {
          return res.status(403).json({ error: "Access denied" });
        }

        // Execute skill
        const result = await skillsService.executeSkill(
          skillName,
          agentId,
          inputData
        );

        if (result === null) {
          return res.status(400).json({ error: "Skill execution failed" });
        }

        logger.info(`Skill executed: ${skillName} for agent ${agentId}`);

        res.json({
          success: true,
          result,
        });
      } catch (error: any) {
        logger.error(`Error executing skill: ${error?.message}`);
        res.status(500).json({ error: "Failed to execute skill" });
      }
    }
  );

  /**
   * POST /api/skills/:skillId/rate - Rate a skill
   */
  router.post("/:skillId/rate", validate(rateSkillSchema), async (req, res) => {
    try {
      const skillId = (req.params as any).skillId as string;
      const { rating, review } = req.body;
      const userId = (req.actor as any).userId;

      // Verify skill exists
      const skill = await db
        .select()
        .from(skills)
        .where(eq(skills.id, skillId))
        .then((rows) => rows[0] ?? null);

      if (!skill) {
        return res.status(404).json({ error: "Skill not found" });
      }

      // Check if already reviewed
      const existing = await db
        .select()
        .from(skillReviews)
        .where(
          and(
            eq(skillReviews.skillId, skillId),
            eq(skillReviews.userId, userId)
          )
        )
        .then((rows) => rows[0] ?? null);

      if (existing) {
        // Update existing review
        await db
          .update(skillReviews)
          .set({
            rating,
            reviewText: review || null,
            updatedAt: new Date(),
          })
          .where(eq(skillReviews.id, existing.id));
      } else {
        // Create new review
        await db.insert(skillReviews).values({
          skillId,
          userId,
          rating,
          reviewText: review || null,
        });
      }

      // Update skill rating
      const allReviews = await db
        .select()
        .from(skillReviews)
        .where(eq(skillReviews.skillId, skillId));

      const avgRating =
        allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length;

      await db
        .update(skills)
        .set({
          rating: avgRating,
          ratingCount: allReviews.length,
        })
        .where(eq(skills.id, skillId));

      logger.info(`Skill rated: ${skillId} with ${rating} stars`);

      res.json({
        success: true,
        message: "Rating saved",
        averageRating: avgRating,
      });
    } catch (error: any) {
      logger.error(`Error rating skill: ${error?.message}`);
      res.status(500).json({ error: "Failed to rate skill" });
    }
  });

  return router;
}
