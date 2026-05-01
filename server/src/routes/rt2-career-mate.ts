import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2CareerMateService } from "../services/rt2-career-mate.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2CareerMateRoutes(db: Db) {
  const router = Router();
  const careerService = rt2CareerMateService(db);

  // ===== Career Profiles =====

  /**
   * GET /companies/:companyId/rt2/career/progression/:agentId
   * Derive CareerMate progression from settlement, ledger, quality, and gamification evidence.
   */
  router.get("/companies/:companyId/rt2/career/progression/:agentId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agentId = req.params.agentId;

      const progression = await careerService.getCareerProgression(companyId, agentId);
      return res.json(progression);
    } catch (error) {
      console.error("Error getting career progression:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/career/profile/:agentId
   * Get career profile for an agent
   */
  router.get("/companies/:companyId/rt2/career/profile/:agentId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agentId = req.params.agentId;

      const profile = await careerService.getCareerProfileByAgent(companyId, agentId);

      if (!profile) {
        return res.status(404).json({ error: "Career profile not found" });
      }

      return res.json(profile);
    } catch (error) {
      console.error("Error getting career profile:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * PUT /companies/:companyId/rt2/career/profile/:agentId
   * Create or update career profile
   */
  router.put("/companies/:companyId/rt2/career/profile/:agentId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agentId = req.params.agentId;
      const { name, title, summary, skills, certifications, yearsOfExperience } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }

      const profile = await careerService.upsertCareerProfile(companyId, agentId, {
        name,
        title,
        summary,
        skills,
        certifications,
        yearsOfExperience,
      });

      return res.json(profile);
    } catch (error) {
      console.error("Error upserting career profile:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/career/public
   * Get public career profiles
   */
  router.get("/companies/:companyId/rt2/career/public", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const profiles = await careerService.getPublicProfiles();
      return res.json(profiles);
    } catch (error) {
      console.error("Error getting public profiles:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/career/profile/:profileId/export
   * Export portable career data
   */
  router.post("/companies/:companyId/rt2/career/profile/:profileId/export", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const profileId = req.params.profileId;

      const portableData = await careerService.exportPortableData(profileId);

      if (!portableData) {
        return res.status(404).json({ error: "Career profile not found" });
      }

      return res.json(portableData);
    } catch (error) {
      console.error("Error exporting career data:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ===== Portfolio =====

  /**
   * GET /companies/:companyId/rt2/career/portfolio/:profileId
   * Get portfolio entries for a career profile
   */
  router.get("/companies/:companyId/rt2/career/portfolio/:profileId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const profileId = req.params.profileId;
      const { category, featured } = req.query;

      const entries = await careerService.getPortfolioEntries(profileId, {
        category: category as string | undefined,
        featured: featured === "true" ? true : featured === "false" ? false : undefined,
      });

      return res.json(entries);
    } catch (error) {
      console.error("Error getting portfolio entries:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/career/portfolio
   * Add work product to portfolio
   */
  router.post("/companies/:companyId/rt2/career/portfolio", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { careerProfileId, workProductId, title, description, category, tags, qualityScore, complexityLevel, impactSummary, evidenceUrls } = req.body;

      if (!careerProfileId || !title || !category) {
        return res.status(400).json({ error: "careerProfileId, title, and category are required" });
      }

      const entry = await careerService.addToPortfolio(careerProfileId, companyId, {
        workProductId,
        title,
        description,
        category,
        tags,
        qualityScore,
        complexityLevel,
        impactSummary,
        evidenceUrls,
      });

      return res.status(201).json(entry);
    } catch (error) {
      console.error("Error adding to portfolio:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * PATCH /companies/:companyId/rt2/career/portfolio/:entryId
   * Update portfolio entry
   */
  router.patch("/companies/:companyId/rt2/career/portfolio/:entryId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const entryId = req.params.entryId;
      const updates = req.body;

      const entry = await careerService.updatePortfolioEntry(entryId, updates);

      return res.json(entry);
    } catch (error) {
      console.error("Error updating portfolio entry:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ===== Skill Transfers =====

  /**
   * POST /companies/:companyId/rt2/career/skills/export
   * Export skills from profile
   */
  router.post("/companies/:companyId/rt2/career/skills/export", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { profileId, skills, destCompanyId } = req.body;

      if (!profileId || !skills || !Array.isArray(skills)) {
        return res.status(400).json({ error: "profileId and skills array are required" });
      }

      const transfer = await careerService.exportSkills(companyId, profileId, skills, destCompanyId);

      return res.status(201).json(transfer);
    } catch (error) {
      console.error("Error exporting skills:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/career/skills/import
   * Import skills to profile
   */
  router.post("/companies/:companyId/rt2/career/skills/import", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { profileId, skills, sourceCompanyId } = req.body;

      if (!profileId || !skills || !Array.isArray(skills)) {
        return res.status(400).json({ error: "profileId and skills array are required" });
      }

      const transfer = await careerService.importSkills(companyId, profileId, skills, sourceCompanyId);

      return res.status(201).json(transfer);
    } catch (error) {
      console.error("Error importing skills:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/career/skills/share
   * Share skills between profiles
   */
  router.post("/companies/:companyId/rt2/career/skills/share", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { sourceProfileId, destProfileId, skills, reason } = req.body;

      if (!sourceProfileId || !destProfileId || !skills || !Array.isArray(skills)) {
        return res.status(400).json({ error: "sourceProfileId, destProfileId, and skills array are required" });
      }

      const transfer = await careerService.shareSkills(
        companyId,
        sourceProfileId,
        destProfileId,
        skills,
        reason,
      );

      return res.status(201).json(transfer);
    } catch (error) {
      console.error("Error sharing skills:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/career/skills/transfers/:profileId
   * Get skill transfers for a profile
   */
  router.get("/companies/:companyId/rt2/career/skills/transfers/:profileId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const profileId = req.params.profileId;

      const transfers = await careerService.getSkillTransfers(profileId);

      return res.json(transfers);
    } catch (error) {
      console.error("Error getting skill transfers:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ===== Milestones =====

  /**
   * GET /companies/:companyId/rt2/career/milestones/:profileId
   * Get milestones for a career profile
   */
  router.get("/companies/:companyId/rt2/career/milestones/:profileId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const profileId = req.params.profileId;

      const milestones = await careerService.getMilestones(profileId);

      return res.json(milestones);
    } catch (error) {
      console.error("Error getting milestones:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/career/milestones
   * Add career milestone
   */
  router.post("/companies/:companyId/rt2/career/milestones", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { careerProfileId, title, description, category, achievedAt, evidenceUrls, impactMetrics } = req.body;

      if (!careerProfileId || !title || !category) {
        return res.status(400).json({ error: "careerProfileId, title, and category are required" });
      }

      const milestone = await careerService.addMilestone(careerProfileId, companyId, {
        title,
        description,
        category,
        achievedAt: achievedAt ? new Date(achievedAt) : undefined,
        evidenceUrls,
        impactMetrics,
      });

      return res.status(201).json(milestone);
    } catch (error) {
      console.error("Error adding milestone:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
