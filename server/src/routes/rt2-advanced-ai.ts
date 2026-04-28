import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2AdvancedAIService } from "../services/rt2-advanced-ai.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2AdvancedAIRoutes(db: Db) {
  const router = Router();
  const aiService = rt2AdvancedAIService(db);

  // ===== Reverse Design (역설계) =====

  /**
   * POST /companies/:companyId/rt2/reverse-design
   * Create reverse design analysis run
   */
  router.post("/companies/:companyId/rt2/reverse-design", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { targetType, targetId, resultData, contextData, method } = req.body;

      if (!targetType || !targetId || !resultData) {
        return res.status(400).json({ error: "targetType, targetId, and resultData are required" });
      }

      const run = await aiService.createReverseDesignRun(companyId, targetType, targetId, resultData, {
        contextData,
        method,
      });

      return res.status(201).json(run);
    } catch (error) {
      console.error("Error creating reverse design run:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/reverse-design/:runId/complete
   * Complete reverse design run with analysis
   */
  router.post("/companies/:companyId/rt2/reverse-design/:runId/complete", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const runId = req.params.runId;
      const { inferredCauses, rootCause, confidenceScore, reconstructedProcess } = req.body;

      if (!inferredCauses || confidenceScore === undefined || !reconstructedProcess) {
        return res.status(400).json({ error: "inferredCauses, confidenceScore, and reconstructedProcess are required" });
      }

      const run = await aiService.completeReverseDesignRun(runId, {
        inferredCauses,
        rootCause,
        confidenceScore,
        reconstructedProcess,
      });

      return res.json(run);
    } catch (error) {
      console.error("Error completing reverse design run:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/reverse-design
   * Get reverse design runs
   */
  router.get("/companies/:companyId/rt2/reverse-design", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { targetType, targetId } = req.query;

      const runs = await aiService.getReverseDesignRuns(
        companyId,
        targetType as string | undefined,
        targetId as string | undefined,
      );

      return res.json(runs);
    } catch (error) {
      console.error("Error getting reverse design runs:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/companies/:companyId/rt2/jarvis/reverse-design-tasks", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { title, type, description, projectId } = req.body;

      if (!title || !type) {
        return res.status(400).json({ error: "title and type are required" });
      }

      const proposal = await aiService.proposeTasksFromExpectedDeliverable(companyId, {
        title,
        type,
        description,
        projectId,
      });

      return res.status(201).json(proposal);
    } catch (error) {
      console.error("Error proposing reverse-designed Jarvis tasks:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ===== Process Mining (프로세스 마이닝) =====

  /**
   * POST /companies/:companyId/rt2/process-mining
   * Create or get process mining snapshot
   */
  router.post("/companies/:companyId/rt2/process-mining", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { processType, processKey } = req.body;

      if (!processType || !processKey) {
        return res.status(400).json({ error: "processType and processKey are required" });
      }

      const snapshot = await aiService.upsertProcessMiningSnapshot(companyId, processType, processKey);

      return res.json(snapshot);
    } catch (error) {
      console.error("Error creating process mining snapshot:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/process-mining/:snapshotId/traces
   * Add traces to process mining snapshot
   */
  router.post("/companies/:companyId/rt2/process-mining/:snapshotId/traces", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const snapshotId = req.params.snapshotId;
      const { traces } = req.body;

      if (!traces || !Array.isArray(traces)) {
        return res.status(400).json({ error: "traces array is required" });
      }

      const snapshot = await aiService.addProcessTraces(snapshotId, traces);

      return res.json(snapshot);
    } catch (error) {
      console.error("Error adding process traces:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * PATCH /companies/:companyId/rt2/process-mining/:snapshotId/analysis
   * Update patterns and bottlenecks
   */
  router.patch("/companies/:companyId/rt2/process-mining/:snapshotId/analysis", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const snapshotId = req.params.snapshotId;
      const { patterns, bottlenecks, recommendations } = req.body;

      if (!patterns || !bottlenecks || !recommendations) {
        return res.status(400).json({ error: "patterns, bottlenecks, and recommendations are required" });
      }

      const snapshot = await aiService.updateProcessAnalysis(snapshotId, patterns, bottlenecks, recommendations);

      return res.json(snapshot);
    } catch (error) {
      console.error("Error updating process analysis:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/process-mining
   * Get process mining snapshots
   */
  router.get("/companies/:companyId/rt2/process-mining", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { processType } = req.query;

      const snapshots = await aiService.getProcessMiningSnapshots(companyId, processType as string | undefined);

      return res.json(snapshots);
    } catch (error) {
      console.error("Error getting process mining snapshots:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ===== Runtime Skill Injection =====

  /**
   * POST /companies/:companyId/rt2/skill-injections
   * Create skill injection
   */
  router.post("/companies/:companyId/rt2/skill-injections", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { agentId, skillKey, skillId, context, injectionType, expiresAt } = req.body;

      if (!agentId || !skillKey) {
        return res.status(400).json({ error: "agentId and skillKey are required" });
      }

      const injection = await aiService.createSkillInjection(companyId, agentId, skillKey, {
        skillId,
        context,
        injectionType,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      });

      return res.status(201).json(injection);
    } catch (error) {
      console.error("Error creating skill injection:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/companies/:companyId/rt2/jarvis/skill-capabilities", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;

      const capabilities = await aiService.listSkillCapabilities(companyId, agentId);
      return res.json(capabilities);
    } catch (error) {
      console.error("Error listing Jarvis skill capabilities:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/companies/:companyId/rt2/jarvis/skill-capabilities", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { agentId, skillKey, skillId, context, injectionType, expiresAt } = req.body;

      if (!agentId || !skillKey) {
        return res.status(400).json({ error: "agentId and skillKey are required" });
      }

      const capability = await aiService.createGovernedSkillCapability(companyId, agentId, skillKey, {
        skillId,
        context,
        injectionType,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        requestedByUserId: req.actor.userId,
      });

      return res.status(201).json(capability);
    } catch (error) {
      console.error("Error creating Jarvis skill capability:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/skill-injections/:injectionId/activate
   * Activate skill injection
   */
  router.post("/companies/:companyId/rt2/skill-injections/:injectionId/activate", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const injectionId = req.params.injectionId;

      const injection = await aiService.activateSkillInjection(injectionId);

      return res.json(injection);
    } catch (error) {
      console.error("Error activating skill injection:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/skill-injections/:injectionId/usage
   * Record skill injection usage
   */
  router.post("/companies/:companyId/rt2/skill-injections/:injectionId/usage", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const injectionId = req.params.injectionId;

      await aiService.recordSkillInjectionUsage(injectionId);

      return res.json({ success: true });
    } catch (error) {
      console.error("Error recording skill injection usage:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * PATCH /companies/:companyId/rt2/skill-injections/:injectionId/effectiveness
   * Update skill injection effectiveness
   */
  router.patch("/companies/:companyId/rt2/skill-injections/:injectionId/effectiveness", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const injectionId = req.params.injectionId;
      const { effectivenessScore } = req.body;

      if (effectivenessScore === undefined) {
        return res.status(400).json({ error: "effectivenessScore is required" });
      }

      const injection = await aiService.updateSkillInjectionEffectiveness(injectionId, effectivenessScore);

      return res.json(injection);
    } catch (error) {
      console.error("Error updating skill injection effectiveness:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/rt2/skill-injections/:injectionId/deactivate
   * Deactivate skill injection
   */
  router.post("/companies/:companyId/rt2/skill-injections/:injectionId/deactivate", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const injectionId = req.params.injectionId;

      const injection = await aiService.deactivateSkillInjection(injectionId);

      return res.json(injection);
    } catch (error) {
      console.error("Error deactivating skill injection:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/skill-injections/agent/:agentId
   * Get active skill injections for an agent
   */
  router.get("/companies/:companyId/rt2/skill-injections/agent/:agentId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agentId = req.params.agentId;

      const injections = await aiService.getActiveSkillInjections(agentId);

      return res.json(injections);
    } catch (error) {
      console.error("Error getting active skill injections:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
