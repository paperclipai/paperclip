import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agents } from "@ironworksai/db";
import { assertCanWrite } from "./authz.js";
import { badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  sanitizeAiInput,
  validateGoalBreakdownOutput,
  type GoalBreakdownResult,
} from "../lib/ai-security.js";

const AVAILABLE_ROLES = [
  "ceo",
  "cto",
  "cmo",
  "vphr",
  "seniorengineer",
  "devopsengineer",
  "securityengineer",
  "contentmarketer",
] as const;

type Priority = "high" | "medium" | "low";

interface GeneratedIssue {
  title: string;
  description: string;
  priority: Priority;
  assigneeRole: string;
  order: number;
}

/**
 * AI-assisted goal breakdown endpoints.
 * Generates structured issues from a high-level goal using Anthropic API
 * when available, or falls back to template-based generation.
 */
export function aiGoalBreakdownRoutes(db: Db) {
  const router = Router();

  router.post(
    "/companies/:companyId/ai/generate-goal-breakdown",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanWrite(req, companyId, db);

      const { goalTitle: rawGoalTitle, goalDescription: rawGoalDescription, projectId } = req.body as {
        goalTitle?: string;
        goalDescription?: string;
        projectId?: string;
      };

      if (!rawGoalTitle || rawGoalTitle.trim().length === 0) {
        throw badRequest("goalTitle is required");
      }

      // SEC-LLM-001: sanitize user inputs before interpolating into LLM prompts
      const goalTitle = sanitizeAiInput(rawGoalTitle, "goalTitle");
      const goalDescription = rawGoalDescription != null
        ? sanitizeAiInput(rawGoalDescription, "goalDescription")
        : undefined;

      // Load company agents to determine available roles
      const companyAgents = await db
        .select({ name: agents.name, role: agents.role })
        .from(agents)
        .where(eq(agents.companyId, companyId));

      const agentRoles = companyAgents.map((a) => a.role?.toLowerCase() ?? a.name.toLowerCase());

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        try {
          const result = await generateWithAnthropic(
            apiKey,
            goalTitle,
            goalDescription,
            agentRoles,
          );
          res.json(result);
          return;
        } catch (err) {
          logger.warn(
            { err },
            "Anthropic API call failed for goal breakdown, falling back to template",
          );
        }
      }

      // Fallback: template-based breakdown
      const result = generateTemplateBreakdown(goalTitle, goalDescription, agentRoles);
      res.json(result);
    },
  );

  return router;
}

async function generateWithAnthropic(
  apiKey: string,
  goalTitle: string,
  goalDescription: string | undefined,
  availableRoles: string[],
): Promise<GoalBreakdownResult> {
  const roleList =
    availableRoles.length > 0
      ? availableRoles.join(", ")
      : AVAILABLE_ROLES.join(", ");

  const systemPrompt = `You are an AI project planner. Given a goal, break it down into actionable issues that a team of AI agents can execute.

Available agent roles: ${roleList}

Respond ONLY with valid JSON matching this schema:
{
  "issues": [
    {
      "title": "Short issue title",
      "description": "Detailed description of what needs to be done",
      "priority": "high|medium|low",
      "assigneeRole": "one of the available roles (lowercase)",
      "order": 1
    }
  ]
}

Rules:
- Generate 3-7 issues depending on goal complexity
- Order issues logically (earlier tasks first)
- High-priority items are blockers or foundational work
- Medium-priority items are the core implementation tasks
- Low-priority items are polish, documentation, or follow-up
- Each issue should be specific and independently actionable
- Assign roles based on expertise match; default to "ceo" for strategic tasks
- Descriptions should be detailed enough for an AI agent to execute`;

  const userPrompt = goalDescription
    ? `Goal: ${goalTitle}\n\nDescription: ${goalDescription}`
    : `Goal: ${goalTitle}`;

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
      messages: [{ role: "user", content: userPrompt }],
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
  return validateGoalBreakdownOutput(JSON.parse(jsonMatch[0]));
}

/**
 * Fallback: generate a template breakdown with generic phases.
 */
function generateTemplateBreakdown(
  goalTitle: string,
  goalDescription: string | undefined,
  availableRoles: string[],
): GoalBreakdownResult {
  const ceo = availableRoles.find((r) => r.includes("ceo")) ?? "ceo";
  const cto =
    availableRoles.find((r) => r.includes("cto")) ??
    availableRoles.find((r) => r.includes("engineer")) ??
    "cto";
  const engineer =
    availableRoles.find((r) => r.includes("senior") || r.includes("engineer")) ??
    "seniorengineer";

  const context = goalDescription
    ? `${goalTitle} - ${goalDescription}`
    : goalTitle;

  const issues: GeneratedIssue[] = [
    {
      title: `Define scope and requirements for: ${goalTitle}`,
      description: `Analyze the goal and define clear scope, acceptance criteria, and deliverables.\n\nGoal context: ${context}`,
      priority: "high",
      assigneeRole: ceo,
      order: 1,
    },
    {
      title: `Design solution approach`,
      description: `Based on the scoped requirements, design the technical or strategic approach. Identify key decisions, dependencies, and potential risks.`,
      priority: "high",
      assigneeRole: cto,
      order: 2,
    },
    {
      title: `Implement core deliverables`,
      description: `Execute the primary work defined in the design phase. Follow the agreed approach and document progress.`,
      priority: "medium",
      assigneeRole: engineer,
      order: 3,
    },
    {
      title: `Review and validate output`,
      description: `Review all deliverables against the acceptance criteria defined in the scoping phase. Identify gaps and request revisions if needed.`,
      priority: "medium",
      assigneeRole: cto,
      order: 4,
    },
    {
      title: `Final delivery and stakeholder sign-off`,
      description: `Package deliverables, communicate results to stakeholders, and obtain final approval. Document lessons learned.`,
      priority: "low",
      assigneeRole: ceo,
      order: 5,
    },
  ];

  return { issues };
}
