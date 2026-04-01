import { Router } from "express";
import type { Db } from "@ironworksai/db";
import { agents } from "@ironworksai/db";
import { eq } from "drizzle-orm";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  sanitizeAiInput,
  validatePlaybookOutput,
  type GeneratedPlaybook,
} from "../lib/ai-security.js";

/**
 * AI generation endpoints for playbooks, routines, etc.
 * Attempts to use Anthropic API if ANTHROPIC_API_KEY is set,
 * falls back to template-based generation otherwise.
 */
export function aiGenerateRoutes(db: Db) {
  const router = Router();

  /** Generate a playbook from a natural language description. */
  router.post("/companies/:companyId/ai/generate-playbook", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { prompt: rawPrompt } = req.body as { prompt?: string };
    if (!rawPrompt || rawPrompt.trim().length < 10) {
      throw badRequest("Prompt must be at least 10 characters");
    }
    // SEC-LLM-001: sanitize before interpolating into LLM prompt
    const prompt = sanitizeAiInput(rawPrompt, "prompt");

    // Get company agents for role matching
    const companyAgents = await db
      .select({ name: agents.name, role: agents.role })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const agentRoles = companyAgents.map((a) => a.name.toLowerCase());

    // Try Anthropic API if key is available
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        const result = await generateWithAnthropic(apiKey, prompt, agentRoles);
        res.json(result);
        return;
      } catch (err) {
        logger.warn({ err }, "Anthropic API call failed, falling back to template generation");
      }
    }

    // Fallback: template-based generation
    const result = generateFromTemplate(prompt, agentRoles);
    res.json(result);
  });

  return router;
}

async function generateWithAnthropic(
  apiKey: string,
  prompt: string,
  availableRoles: string[],
): Promise<GeneratedPlaybook> {
  const systemPrompt = `You are an AI workflow architect. Generate a structured playbook from the user's description.

Available agent roles: ${availableRoles.join(", ") || "ceo, cto, seniorengineer"}

Respond ONLY with valid JSON matching this schema:
{
  "name": "Short playbook name",
  "description": "One-liner description",
  "body": "Detailed explanation of the playbook",
  "category": "onboarding|security|engineering|operations|marketing|custom",
  "steps": [
    {
      "stepOrder": 1,
      "title": "Step title",
      "instructions": "Detailed instructions for the agent",
      "assigneeRole": "agent role name (lowercase)",
      "dependsOn": [],
      "requiresApproval": false
    }
  ]
}

Rules:
- Steps should be specific and actionable
- Use dependsOn to create a DAG (directed acyclic graph) of step dependencies
- Only the final review step should have requiresApproval: true
- Assign roles from the available list, defaulting to "ceo" for leadership tasks
- Generate 4-8 steps for most playbooks
- Instructions should be detailed enough for an AI agent to execute without ambiguity`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${err}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };

  const text = data.content.find((c) => c.type === "text")?.text ?? "";

  // Extract JSON from the response (may be wrapped in markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in Anthropic response");
  }

  // SEC-LLM-002: validate schema and strip unexpected fields before returning
  return validatePlaybookOutput(JSON.parse(jsonMatch[0]));
}

/**
 * Fallback: generate a basic playbook structure from the prompt using heuristics.
 */
function generateFromTemplate(prompt: string, availableRoles: string[]): GeneratedPlaybook {
  const lowerPrompt = prompt.toLowerCase();

  // Detect category
  let category: GeneratedPlaybook["category"] = "custom";
  if (lowerPrompt.includes("security") || lowerPrompt.includes("audit")) category = "security";
  else if (lowerPrompt.includes("onboard") || lowerPrompt.includes("client")) category = "onboarding";
  else if (lowerPrompt.includes("launch") || lowerPrompt.includes("release") || lowerPrompt.includes("deploy")) category = "engineering";
  else if (lowerPrompt.includes("content") || lowerPrompt.includes("marketing") || lowerPrompt.includes("campaign")) category = "marketing";
  else if (lowerPrompt.includes("incident") || lowerPrompt.includes("ops") || lowerPrompt.includes("review")) category = "operations";

  // Extract a name from the first sentence
  const firstSentence = prompt.split(/[.!?\n]/)[0]?.trim() ?? "Custom Playbook";
  const name = firstSentence.length > 60 ? firstSentence.slice(0, 57) + "..." : firstSentence;

  // Determine roles to use
  const ceo = availableRoles.includes("ceo") ? "ceo" : availableRoles[0] ?? "ceo";
  const cto = availableRoles.find((r) => r.includes("cto") || r.includes("engineer")) ?? ceo;
  const executor = availableRoles.find((r) => r.includes("senior") || r.includes("engineer")) ?? cto;

  const steps: GeneratedPlaybook["steps"] = [
    {
      stepOrder: 1,
      title: "Define scope and goals",
      instructions: `Based on this request: "${prompt}"\n\nDefine clear scope, success criteria, and deliverables. Document the plan.`,
      assigneeRole: ceo,
      dependsOn: [],
      requiresApproval: false,
    },
    {
      stepOrder: 2,
      title: "Design approach",
      instructions: `Review the scope from Step 1. Design the technical or strategic approach. Document key decisions and trade-offs.`,
      assigneeRole: cto,
      dependsOn: [1],
      requiresApproval: false,
    },
    {
      stepOrder: 3,
      title: "Execute primary work",
      instructions: `Implement the plan from Step 2. Follow the design approach. Document progress and any deviations from the plan.`,
      assigneeRole: executor,
      dependsOn: [2],
      requiresApproval: false,
    },
    {
      stepOrder: 4,
      title: "Review and verify",
      instructions: `Review the output from Step 3. Verify it meets the goals defined in Step 1. Document any gaps or follow-up items.`,
      assigneeRole: cto,
      dependsOn: [3],
      requiresApproval: false,
    },
    {
      stepOrder: 5,
      title: "Final approval and delivery",
      instructions: `Review all deliverables. Approve for delivery or request revisions. Communicate results to stakeholders.`,
      assigneeRole: ceo,
      dependsOn: [4],
      requiresApproval: true,
    },
  ];

  return {
    name,
    description: `Auto-generated playbook from: ${prompt.slice(0, 100)}`,
    body: prompt,
    category,
    steps,
  };
}
