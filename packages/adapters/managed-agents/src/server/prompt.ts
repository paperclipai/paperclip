import type { CookbookSkillDetail } from "./client.js";

export interface PromptInput {
  role: string;
  outputFormat?: string;
  cornerstoneContext?: string | null;
  skills?: CookbookSkillDetail[];
  task: {
    key?: string | null;
    body: string;
  };
}

// Renders the system prompt baked into the Managed Agent itself (role + skills
// + output format) and the per-turn user prompt (Cornerstone memory + task body).
// Kept as plain string concat — no template engine, no handlebars. Rough code.
export function renderSystemPrompt(input: PromptInput): string {
  const parts: string[] = [];
  parts.push(`You are: ${input.role}`);
  parts.push("");
  if (input.skills && input.skills.length > 0) {
    parts.push("## Skills available");
    parts.push(
      "The following skills ARE part of your knowledge. Apply them when they match the task.",
    );
    parts.push("");
    for (const skill of input.skills) {
      parts.push(`### Skill: ${skill.name}`);
      parts.push(skill.content.trim());
      parts.push("");
    }
  }
  if (input.outputFormat) {
    parts.push(`## Output format\nReturn your final answer as ${input.outputFormat}.`);
    parts.push("");
  }
  parts.push("## Operating rules");
  parts.push("- Keep answers focused and useful.");
  parts.push("- Cite specifics from the provided memory context when relevant.");
  parts.push("- If the task is ambiguous, state your assumption and proceed.");
  return parts.join("\n");
}

export function renderUserTurn(input: PromptInput): string {
  const parts: string[] = [];
  if (input.cornerstoneContext && input.cornerstoneContext.trim().length > 0) {
    parts.push("## Memory context (from Cornerstone)");
    parts.push(input.cornerstoneContext.trim());
    parts.push("");
  }
  parts.push("## Task");
  if (input.task.key) parts.push(`Task key: ${input.task.key}`);
  parts.push(input.task.body.trim());
  return parts.join("\n");
}
