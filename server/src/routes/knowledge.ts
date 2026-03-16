import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { knowledgeDocuments } from "@paperclipai/db";
import { eq, desc } from "drizzle-orm";
import { validate } from "../middleware/validate.js";
import { z } from "zod";
import { logger } from "../middleware/logger.js";
import { getContextManager } from "../services/context-manager.js";
import { agentService } from "../services/index.js";

const documentUploadSchema = z.object({
  name: z.string().min(1, "Document name required"),
  agentId: z.string().uuid("Invalid agent ID").optional(),
});

const searchSchema = z.object({
  query: z.string().min(1, "Search query required"),
  limit: z.number().int().positive().default(5),
});

const getContextSchema = z.object({
  query: z.string().optional(),
});

export function knowledgeRoutes(db: Db) {
  const router = Router({ mergeParams: true });
  const contextManager = getContextManager(db);
  const agentSvc = agentService(db);

  /**
   * POST /companies/:companyId/knowledge/documents - Upload document
   */
  router.post(
    "/:companyId/knowledge/documents",
    validate(documentUploadSchema),
    async (req, res) => {
      try {
        const companyId = (req.params as any).companyId as string;
        const { name, agentId } = req.body;
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

        // Create document record
        const doc = await db.insert(knowledgeDocuments).values({
          companyId,
          agentId: agentId || null,
          name,
          contentType: "text/plain", // Default, would be set based on file upload
          status: "ready",
          createdBy: userId,
        });

        logger.info(`Document created: ${name} for company ${companyId}`);

        // Return created document
        const documents = await db
          .select()
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.companyId, companyId));

        res.status(201).json({
          message: "Document uploaded successfully",
          documents,
        });
      } catch (error: any) {
        logger.error(`Error uploading document: ${error?.message}`);
        res.status(500).json({ error: "Failed to upload document" });
      }
    }
  );

  /**
   * GET /companies/:companyId/knowledge/documents - List documents
   */
  router.get("/:companyId/knowledge/documents", async (req, res) => {
    try {
      const companyId = (req.params as any).companyId as string;

      // Verify company access
      const companies = (req.actor as any).companyIds || [];
      if (!companies.includes(companyId)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const documents = await db
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.companyId, companyId))
        .orderBy(desc(knowledgeDocuments.createdAt));

      res.json({ documents });
    } catch (error: any) {
      logger.error(`Error fetching documents: ${error?.message}`);
      res.status(500).json({ error: "Failed to fetch documents" });
    }
  });

  /**
   * GET /companies/:companyId/knowledge/documents/:docId - Get document details
   */
  router.get("/:companyId/knowledge/documents/:docId", async (req, res) => {
    try {
      const companyId = (req.params as any).companyId as string;
      const docId = (req.params as any).docId as string;

      // Verify company access
      const companies = (req.actor as any).companyIds || [];
      if (!companies.includes(companyId)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const document = await db
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, docId))
        .then((rows) => rows[0] ?? null);

      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      if (document.companyId !== companyId) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json(document);
    } catch (error: any) {
      logger.error(`Error fetching document: ${error?.message}`);
      res.status(500).json({ error: "Failed to fetch document" });
    }
  });

  /**
   * DELETE /companies/:companyId/knowledge/documents/:docId - Delete document
   */
  router.delete("/:companyId/knowledge/documents/:docId", async (req, res) => {
    try {
      const companyId = (req.params as any).companyId as string;
      const docId = (req.params as any).docId as string;

      // Verify company access
      const companies = (req.actor as any).companyIds || [];
      if (!companies.includes(companyId)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const document = await db
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, docId))
        .then((rows) => rows[0] ?? null);

      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      if (document.companyId !== companyId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Delete document
      await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, docId));

      logger.info(`Document deleted: ${docId}`);
      res.json({ success: true, message: "Document deleted" });
    } catch (error: any) {
      logger.error(`Error deleting document: ${error?.message}`);
      res.status(500).json({ error: "Failed to delete document" });
    }
  });

  /**
   * POST /companies/:companyId/knowledge/search - Search knowledge
   */
  router.post(
    "/:companyId/knowledge/search",
    validate(searchSchema),
    async (req, res) => {
      try {
        const companyId = (req.params as any).companyId as string;
        const { query, limit } = req.body;

        // Verify company access
        const companies = (req.actor as any).companyIds || [];
        if (!companies.includes(companyId)) {
          return res.status(403).json({ error: "Access denied" });
        }

        // For MVP, return documents that match the query in name
        const documents = await db
          .select()
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.companyId, companyId));

        const results = documents
          .filter((doc) =>
            doc.name.toLowerCase().includes(query.toLowerCase())
          )
          .slice(0, limit);

        logger.info(
          `Knowledge search: "${query}" found ${results.length} results`
        );

        res.json({
          query,
          results,
          total: results.length,
        });
      } catch (error: any) {
        logger.error(`Error searching knowledge: ${error?.message}`);
        res.status(500).json({ error: "Failed to search knowledge" });
      }
    }
  );

  /**
   * GET /agents/:agentId/knowledge/context - Get context for agent
   * Used to build context from knowledge base for agent execution
   */
  router.get("/agents/:agentId/knowledge/context", async (req, res) => {
    try {
      const agentId = (req.params as any).agentId as string;
      const query = (req.query as any).query as string | undefined;

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

      // Build context
      const context = await contextManager.buildAgentContext(agentId, query);

      logger.info(`Context built for agent ${agentId}, tokens: ${context.totalTokens}`);

      res.json(context);
    } catch (error: any) {
      logger.error(`Error building context: ${error?.message}`);
      res.status(500).json({ error: "Failed to build context" });
    }
  });

  /**
   * POST /agents/:agentId/knowledge/memory - Save to agent memory
   */
  router.post("/agents/:agentId/knowledge/memory", async (req, res) => {
    try {
      const agentId = (req.params as any).agentId as string;
      const { memoryType, content, relevanceScore } = req.body;

      // Verify agent exists
      const agent = await agentSvc.getById(agentId);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      // Verify company access
      const companies = (req.actor as any).companyIds || [];
      if (!companies.includes(agent.companyId)) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Save memory
      await contextManager.saveMemory(
        agentId,
        memoryType || "general",
        content,
        relevanceScore || 100
      );

      logger.info(
        `Memory saved for agent ${agentId}, type: ${memoryType || "general"}`
      );

      res.status(201).json({ success: true, message: "Memory saved" });
    } catch (error: any) {
      logger.error(`Error saving memory: ${error?.message}`);
      res.status(500).json({ error: "Failed to save memory" });
    }
  });

  /**
   * GET /agents/:agentId/knowledge/memory - Get agent memories
   */
  router.get("/agents/:agentId/knowledge/memory", async (req, res) => {
    try {
      const agentId = (req.params as any).agentId as string;
      const memoryType = (req.query as any).type as string | undefined;

      // Verify agent exists
      const agent = await agentSvc.getById(agentId);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      // Verify company access
      const companies = (req.actor as any).companyIds || [];
      if (!companies.includes(agent.companyId)) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Get memories
      const memories = await contextManager.getMemoryEntries(agentId, memoryType);

      res.json({ memories, count: memories.length });
    } catch (error: any) {
      logger.error(`Error fetching memories: ${error?.message}`);
      res.status(500).json({ error: "Failed to fetch memories" });
    }
  });

  return router;
}
