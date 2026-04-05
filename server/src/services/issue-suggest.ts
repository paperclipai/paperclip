import { spawn } from "node:child_process";

interface AgentInfo {
  id: string;
  name: string;
  role?: string | null;
  title?: string | null;
}

interface ProjectInfo {
  id: string;
  name: string;
  description?: string | null;
}

export interface SuggestIssueInput {
  rawText: string;
  agents: AgentInfo[];
  projects: ProjectInfo[];
}

export interface IssueSuggestion {
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  assigneeAgentId: string | null;
  projectId: string | null;
  status: string;
}

function sanitize(text: string): string {
  return text.replace(/^---$/gm, "- - -");
}

function buildPrompt(input: SuggestIssueInput): string {
  const agentList = input.agents
    .map((a) => `  - id: "${a.id}", name: "${sanitize(a.name)}"${a.role ? `, role: "${sanitize(a.role)}"` : ""}${a.title ? `, title: "${sanitize(a.title)}"` : ""}`)
    .join("\n");

  const projectList = input.projects
    .map((p) => `  - id: "${p.id}", name: "${sanitize(p.name)}"${p.description ? `, description: "${sanitize(p.description)}"` : ""}`)
    .join("\n");

  return `You are an issue triage assistant. Analyze the following raw input from a user and generate structured issue fields.

Available agents:
${agentList || "  (none)"}

Available projects:
${projectList || "  (none)"}

Raw input from user:
---
${sanitize(input.rawText)}
---

Based on the raw input, generate a JSON object with these fields:
- "title": A clear, concise issue title (imperative form, under 80 chars)
- "description": A detailed description in markdown explaining the problem, expected behavior, and any relevant context from the raw input
- "priority": One of "low", "medium", "high", "critical" based on severity
- "assigneeAgentId": The id of the most appropriate agent to handle this, or null if unclear
- "projectId": The id of the most relevant project, or null if unclear
- "status": "todo"

Match agents and projects by relevance to the issue content. If no clear match, use null.

Respond ONLY with the JSON object, no other text or markdown fences.`;
}

function parseClaudeResponse(text: string): IssueSuggestion {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  const parsed = JSON.parse(cleaned);

  return {
    title: String(parsed.title ?? "").slice(0, 200),
    description: String(parsed.description ?? ""),
    priority: ["low", "medium", "high", "critical"].includes(parsed.priority)
      ? parsed.priority
      : "medium",
    assigneeAgentId: typeof parsed.assigneeAgentId === "string" ? parsed.assigneeAgentId : null,
    projectId: typeof parsed.projectId === "string" ? parsed.projectId : null,
    status: parsed.status ?? "todo",
  };
}

export async function suggestIssueFields(input: SuggestIssueInput): Promise<IssueSuggestion> {
  const prompt = buildPrompt(input);

  const result = await new Promise<string>((resolve, reject) => {
    const proc = spawn("claude", ["--print", "-", "--output-format", "text", "--max-turns", "1"], {
      shell: false,
      env: {
        ...process.env,
        // Strip Claude Code nesting vars to avoid conflicts
        CLAUDECODE: undefined,
        CLAUDE_CODE_ENTRYPOINT: undefined,
        CLAUDE_CODE_SESSION: undefined,
        CLAUDE_CODE_PARENT_SESSION: undefined,
      } as NodeJS.ProcessEnv,
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("Claude CLI timed out after 60 seconds"));
    }, 60_000);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 512_000) {
        proc.kill("SIGTERM");
        reject(new Error("Claude CLI response exceeded size limit"));
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });

  const parsed = parseClaudeResponse(result);

  const validAgentIds = new Set(input.agents.map((a) => a.id));
  const validProjectIds = new Set(input.projects.map((p) => p.id));

  return {
    ...parsed,
    assigneeAgentId: parsed.assigneeAgentId && validAgentIds.has(parsed.assigneeAgentId)
      ? parsed.assigneeAgentId
      : null,
    projectId: parsed.projectId && validProjectIds.has(parsed.projectId)
      ? parsed.projectId
      : null,
  };
}
