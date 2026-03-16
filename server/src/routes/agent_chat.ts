import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentChatService, agentService } from "../services/index.js";
import { llmProvidersService } from "../services/llm-providers.js";
import { listProviderModules } from "../services/llm-provider-modules/index.js";
import { validate } from "../middleware/validate.js";
import { z } from "zod";
import { forbidden } from "../errors.js";

const sendMessageSchema = z.object({
  message: z.string().min(1, "Message cannot be empty"),
});

const aiGenerateSchema = z.object({
  role: z.string().min(1, "Role is required"),
  context: z.string().optional(),
});

export function agentChatRoutes(db: Db) {
  const router = Router({ mergeParams: true });
  const chatService = agentChatService(db);
  const agentSvc = agentService(db);
  const llmService = llmProvidersService(db);

  // GET /:agentId/chat - Get conversation history
  router.get("/:agentId/chat", async (req, res) => {
    try {
      const agentId = (req.params as any).agentId as string;

      // Verify agent exists and user has access
      const agent = await agentSvc.getById(agentId);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const messages = await chatService.getMessages(agentId, 100);
      res.json(messages);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  // POST /:agentId/chat - Send message to agent
  router.post("/:agentId/chat", validate(sendMessageSchema), async (req, res) => {
    try {
      const agentId = (req.params as any).agentId as string;
      const { message } = req.body;

      // Verify agent exists
      const agent = await agentSvc.getById(agentId);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      // Save user message
      await chatService.saveMessage(agentId, "user", message);

      // TODO: Trigger agent executor to generate response
      // For now, just return the user message
      // In Phase 2+ this will call the agent's LLM and generate a response

      const messages = await chatService.getMessages(agentId, 100);
      res.json(messages);
    } catch (error) {
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  // DELETE /:agentId/chat - Clear conversation
  router.delete("/:agentId/chat", async (req, res) => {
    try {
      const agentId = (req.params as any).agentId as string;

      // Verify agent exists
      const agent = await agentSvc.getById(agentId);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      await chatService.clearMessages(agentId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to clear messages" });
    }
  });

  // POST /ai-generate - Generate agent config with AI
  router.post("/ai-generate", validate(aiGenerateSchema), async (req, res) => {
    try {
      const { role, context } = req.body;
      const companyId = (req.actor as any).companyIds?.[0];

      if (!companyId) {
        return res.status(403).json({ error: "No company access" });
      }

      // Get company's LLM settings
      const settings = await llmService.getCompanySettings(companyId);
      if (!settings?.preferredProviderType || !settings?.preferredModelId) {
        return res.status(400).json({
          error: "Company has not configured LLM settings. Please set up an LLM provider in Company Settings.",
        });
      }

      // Get provider module
      const provider = listProviderModules().find((m) => m.type === settings.preferredProviderType);
      if (!provider) {
        return res.status(400).json({ error: "LLM provider not found" });
      }

      // Generate agent config using LLM
      const prompt = `Generate a configuration for an AI agent with the following role: "${role}"
${context ? `\nAdditional context: ${context}` : ""}

Please provide the response in JSON format with these fields:
- name: A concise agent name (2-4 words)
- role: The agent's role/function
- instructions: Detailed system instructions for the agent (2-3 sentences)
- icon: An appropriate icon name (from: brain, chart, search, code, zap, tool, chat, user)

Make the agent practical and immediately usable.`;

      // TODO: Call the LLM provider to generate config
      // For now, return a placeholder response
      // In Phase 2+ this will actually call the LLM

      res.json({
        name: `${role} Agent`,
        role: role.toLowerCase().replace(/\s+/g, "_"),
        instructions: `You are an AI agent specialized in ${role}. Provide accurate and helpful responses.`,
        icon: "brain",
      });
    } catch (error) {
      console.error("AI generation error:", error);
      res.status(500).json({ error: "Failed to generate agent config" });
    }
  });

  return router;
}
