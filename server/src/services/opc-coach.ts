import Anthropic from "@anthropic-ai/sdk";
import type { OPCBlueprint, CoachDecision } from "@paperclipai/shared";

export interface CoachContext {
  proposalText: string;
  blueprint: OPCBlueprint;
  decisions: CoachDecision[];
  userMessage: string;
}

export interface CoachAIResponse {
  response: string;
  proposedDecisions: Array<{
    question: string;
    options: string[];
    recommendation: string;
    rationale: string;
  }>;
}

const SYSTEM_PROMPT = `You are the OPC Founder Operating System coach — a panel of senior advisors compressed into one voice:

- **Elon-style first-principles strategist**: challenge assumptions, shrink scope ruthlessly, find the 10x wedge
- **YC/gstack office-hours partner**: ask the hard questions founders avoid, push for evidence over opinion
- **Product designer**: critique the user journey, empty states, and approval points
- **Engineering lead**: flag technical risk, test gaps, and architecture debt
- **QA/security reviewer**: surface abuse cases, data exposure, auth boundaries
- **Growth/ops lead**: challenge distribution, feedback loops, and cost assumptions

Your job is NOT to be agreeable. Your job is to make the founder's company smaller, sharper, and more likely to survive.

Rules:
1. Challenge weak assumptions directly. Say "I don't buy this because..." not "Perhaps you could consider..."
2. Shrink scope before expanding it. The first launch should prove ONE painful job for ONE reachable customer.
3. Identify the highest-frequency workflow and the narrowest user segment.
4. Propose specific decisions the founder can make NOW, not abstract advice.
5. Keep responses under 300 words unless the founder asks for depth.
6. When a project path or link is provided, focus on auditing what exists and converting gaps into an operating backlog.
7. Reference the current blueprint sections when critiquing — point at what's weak, not generic startup advice.

Always respond in valid JSON with this exact shape:
{
  "response": "Your coaching message to the founder (markdown allowed)",
  "proposedDecisions": [
    {
      "question": "A specific decision the founder needs to make",
      "options": ["Option A", "Option B", "Option C"],
      "recommendation": "Which option you recommend",
      "rationale": "Why this option"
    }
  ]
}

Include 1-3 proposed decisions that are most relevant to the founder's message. Do NOT repeat decisions already made.`;

function buildUserPrompt(ctx: CoachContext): string {
  const parts: string[] = [];

  parts.push(`## Current Blueprint\n\n**Summary:** ${ctx.blueprint.summary}\n\n**Wedge MVP:** ${ctx.blueprint.mvpWedge}\n\n**Target Customer:** ${ctx.blueprint.targetCustomer}\n\n**Architecture:** ${ctx.blueprint.architectureNotes}\n\n**Risks:**\n${ctx.blueprint.risks.map((r) => `- ${r}`).join("\n")}`);

  if (ctx.decisions.length > 0) {
    parts.push(`## Decisions Already Made\n${ctx.decisions.map((d) => `- **${d.question}** → ${d.selectedAnswer}`).join("\n")}`);
  }

  const proposalSnippet = ctx.proposalText.length > 4000
    ? ctx.proposalText.slice(0, 4000) + "\n\n[...truncated...]"
    : ctx.proposalText;
  parts.push(`## Original Proposal (excerpt)\n\n${proposalSnippet}`);

  parts.push(`## Founder's Message\n\n${ctx.userMessage}`);

  return parts.join("\n\n---\n\n");
}

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (client) return client;
  const apiKey = process.env.OPC_COACH_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const baseURL = process.env.OPC_COACH_BASE_URL;
  client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  return client;
}

export async function callCoachAI(ctx: CoachContext): Promise<CoachAIResponse | null> {
  const anthropic = getClient();
  if (!anthropic) return null;

  try {
    const message = await anthropic.messages.create({
      model: process.env.OPC_COACH_MODEL ?? "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildUserPrompt(ctx),
        },
      ],
    });

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // Extract JSON from response (handle markdown code fences, partial JSON)
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
    const jsonStr = (jsonMatch[1] ?? text).trim();

    try {
      const parsed = JSON.parse(jsonStr);

      return {
        response: parsed.response ?? text,
        proposedDecisions: Array.isArray(parsed.proposedDecisions)
          ? parsed.proposedDecisions.slice(0, 5).map((d: Record<string, unknown>) => ({
              question: String(d.question ?? ""),
              options: Array.isArray(d.options) ? d.options.map(String) : [],
              recommendation: String(d.recommendation ?? ""),
              rationale: String(d.rationale ?? ""),
            }))
          : [],
      };
    } catch {
      // JSON parse failed — return raw text as response with no decisions
      // This handles models that don't perfectly follow JSON output format
      return {
        response: text,
        proposedDecisions: [],
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number })?.status;
    console.error(
      `[OPC Coach] AI call failed${status ? ` (HTTP ${status})` : ""}: ${message}`
    );
    if (status === 401 || status === 403) {
      console.error("[OPC Coach] Check OPC_COACH_API_KEY is valid");
    } else if (status === 404) {
      console.error("[OPC Coach] Check OPC_COACH_BASE_URL and OPC_COACH_MODEL are correct");
    }
    return null;
  }
}

export function isCoachAvailable(): boolean {
  return Boolean(process.env.OPC_COACH_API_KEY || process.env.ANTHROPIC_API_KEY);
}
