/**
 * ContextManager - Build context for agents from knowledge base and memory
 * Manages conversation memory, learned facts, and knowledge associations
 */

import type { Db } from "@paperclipai/db";
import { agentMemory, conversationHistory, agentKnowledgeAssociations } from "@paperclipai/db";
import { eq, desc, and, lt, count } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { getVectorStore } from "./vector-store.js";

export interface AgentContext {
  knowledgeContext: string;
  conversationSummary: string;
  learnedFacts: string;
  preferences: string;
  totalTokens: number;
}

export interface MemoryEntry {
  id: string;
  type: string;
  content: Record<string, unknown>;
  relevanceScore: number;
}

export class ContextManager {
  private maxContextTokens = 4000; // Max tokens for context
  private maxRecentMessages = 20; // Recent messages to include
  private vectorStore: ReturnType<typeof getVectorStore>;

  constructor(private db: Db) {
    this.vectorStore = getVectorStore(db);
  }

  /**
   * Build complete context for an agent
   */
  async buildAgentContext(agentId: string, currentQuery?: string): Promise<AgentContext> {
    try {
      const [knowledgeContext, conversationSummary, learnedFacts, preferences] = await Promise.all(
        [
          this.getKnowledgeContext(agentId, currentQuery),
          this.getConversationSummary(agentId),
          this.getLearnedFacts(agentId),
          this.getPreferences(agentId),
        ],
      );

      const totalTokens =
        this.estimateTokens(knowledgeContext) +
        this.estimateTokens(conversationSummary) +
        this.estimateTokens(learnedFacts) +
        this.estimateTokens(preferences);

      return {
        knowledgeContext,
        conversationSummary,
        learnedFacts,
        preferences,
        totalTokens,
      };
    } catch (error: any) {
      logger.error(`Error building agent context: ${error?.message}`);
      return {
        knowledgeContext: "",
        conversationSummary: "",
        learnedFacts: "",
        preferences: "",
        totalTokens: 0,
      };
    }
  }

  /**
   * Get relevant knowledge context for agent
   */
  private async getKnowledgeContext(agentId: string, query?: string): Promise<string> {
    try {
      // If no query, return generic knowledge intro
      if (!query) {
        return "The agent has access to a knowledge base of documents and learned information.";
      }

      // For MVP, we'll use keyword matching instead of full embedding search
      // In production, embed the query and use vector search
      const relatedChunks = await this.getRelatedChunks(agentId, query);

      if (relatedChunks.length === 0) {
        return "";
      }

      const context = relatedChunks
        .slice(0, 5)
        .map((chunk, i) => `${i + 1}. ${chunk.content}`)
        .join("\n\n");

      return `Relevant knowledge from documents:\n${context}`;
    } catch (error: any) {
      logger.error(`Error getting knowledge context: ${error?.message}`);
      return "";
    }
  }

  /**
   * Get related chunks (keyword-based for MVP)
   */
  private async getRelatedChunks(agentId: string, query: string): Promise<any[]> {
    try {
      // Get agent's associated knowledge documents
      const associations = await this.db
        .select()
        .from(agentKnowledgeAssociations)
        .where(eq(agentKnowledgeAssociations.agentId, agentId));

      if (associations.length === 0) {
        return [];
      }

      // For MVP, use simple keyword matching on chunk content
      // Production would embed query and use cosine similarity
      const keywords = query.toLowerCase().split(/\s+/).slice(0, 5);

      // Return empty for MVP - full implementation requires embedding service
      // TODO: Integrate with embedding service for semantic search
      return [];
    } catch (error: any) {
      logger.error(`Error getting related chunks: ${error?.message}`);
      return [];
    }
  }

  /**
   * Get conversation summary for context window
   */
  private async getConversationSummary(agentId: string): Promise<string> {
    try {
      // Get recent conversation messages
      const recentMessages = await this.db
        .select()
        .from(conversationHistory)
        .where(eq(conversationHistory.agentId, agentId))
        .orderBy(desc(conversationHistory.createdAt))
        .limit(this.maxRecentMessages);

      if (recentMessages.length === 0) {
        return "";
      }

      // Reverse to chronological order
      recentMessages.reverse();

      const summary = recentMessages
        .map((msg) => `${msg.role.toUpperCase()}: ${msg.content.substring(0, 200)}`)
        .join("\n");

      return `Recent conversation:\n${summary}`;
    } catch (error: any) {
      logger.error(`Error getting conversation summary: ${error?.message}`);
      return "";
    }
  }

  /**
   * Get learned facts from memory
   */
  private async getLearnedFacts(agentId: string): Promise<string> {
    try {
      const { and } = require("drizzle-orm");
      const facts = await this.db
        .select()
        .from(agentMemory)
        .where(
          and(
            eq(agentMemory.agentId, agentId),
            eq(agentMemory.memoryType, "learned_fact")
          )
        )
        .orderBy(desc(agentMemory.relevanceScore))
        .limit(5);

      if (facts.length === 0) {
        return "";
      }

      const factList = facts
        .map((f: any, i: number) => `${i + 1}. ${JSON.stringify(f.content).substring(0, 100)}`)
        .join("\n");

      return `Learned facts:\n${factList}`;
    } catch (error: any) {
      logger.error(`Error getting learned facts: ${error?.message}`);
      return "";
    }
  }

  /**
   * Get user preferences
   */
  private async getPreferences(agentId: string): Promise<string> {
    try {
      const { and } = require("drizzle-orm");
      const prefs = await this.db
        .select()
        .from(agentMemory)
        .where(
          and(
            eq(agentMemory.agentId, agentId),
            eq(agentMemory.memoryType, "preference")
          )
        )
        .limit(5);

      if (prefs.length === 0) {
        return "";
      }

      const prefList = prefs
        .map((p: any, i: number) => `${i + 1}. ${JSON.stringify(p.content).substring(0, 100)}`)
        .join("\n");

      return `User preferences:\n${prefList}`;
    } catch (error: any) {
      logger.error(`Error getting preferences: ${error?.message}`);
      return "";
    }
  }

  /**
   * Save memory entry
   */
  async saveMemory(
    agentId: string,
    memoryType: string,
    content: Record<string, unknown>,
    relevanceScore = 100,
  ): Promise<void> {
    try {
      await this.db.insert(agentMemory).values({
        agentId,
        memoryType,
        content,
        relevanceScore,
      });

      logger.info(`Saved ${memoryType} memory for agent ${agentId}`);
    } catch (error: any) {
      logger.error(`Error saving memory: ${error?.message}`);
    }
  }

  /**
   * Add conversation message to history
   */
  async recordMessage(agentId: string, role: string, content: string, tokens?: number): Promise<void> {
    try {
      await this.db.insert(conversationHistory).values({
        agentId,
        role,
        content,
        tokens: tokens || this.estimateTokens(content),
      });
    } catch (error: any) {
      logger.error(`Error recording message: ${error?.message}`);
    }
  }

  /**
   * Estimate token count
   */
  private estimateTokens(text: string): number {
    if (!text) return 0;
    const words = text.split(/\s+/).length;
    return Math.ceil(words / 1.3);
  }

  /**
   * Get memory entries for agent
   */
  async getMemoryEntries(agentId: string, memoryType?: string): Promise<MemoryEntry[]> {
    try {
      let query = this.db.select().from(agentMemory).where(eq(agentMemory.agentId, agentId)) as any;

      if (memoryType) {
        query = query.where(eq(agentMemory.memoryType, memoryType));
      }

      const entries = await query.orderBy(desc(agentMemory.relevanceScore)).limit(20);

      return entries.map((e: any) => ({
        id: e.id,
        type: e.memoryType,
        content: e.content,
        relevanceScore: e.relevanceScore,
      }));
    } catch (error: any) {
      logger.error(`Error getting memory entries: ${error?.message}`);
      return [];
    }
  }

  /**
   * Prune old conversation history
   */
  async pruneOldConversations(agentId: string, maxAge = 30): Promise<number> {
    try {
      const cutoffDate = new Date(Date.now() - maxAge * 24 * 60 * 60 * 1000);

      // Count rows to be deleted
      const countResult = await this.db
        .select({ count: count() })
        .from(conversationHistory)
        .where(
          and(
            eq(conversationHistory.agentId, agentId),
            lt(conversationHistory.createdAt, cutoffDate),
          ),
        );

      const rowCount = countResult[0]?.count || 0;

      // Delete old messages
      await this.db
        .delete(conversationHistory)
        .where(
          and(
            eq(conversationHistory.agentId, agentId),
            lt(conversationHistory.createdAt, cutoffDate),
          ),
        );

      logger.info(`Pruned ${rowCount} old messages for agent ${agentId}`);
      return rowCount;
    } catch (error: any) {
      logger.error(`Error pruning conversations: ${error?.message}`);
      return 0;
    }
  }
}

/**
 * Factory function
 */
export function getContextManager(db: Db): ContextManager {
  return new ContextManager(db);
}
