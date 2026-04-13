import { Router } from "express";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

/** Resolve full path for a CLI command. */
function resolveCmd(cmd: string): string {
  const searchPaths = [
    `${homedir()}/.local/bin/${cmd}`,
    `/opt/homebrew/bin/${cmd}`,
    `/usr/local/bin/${cmd}`,
    `/usr/bin/${cmd}`,
  ];
  for (const p of searchPaths) {
    if (existsSync(p)) return p;
  }
  return cmd;
}

function runGemini(prompt: string, timeoutMs = 60_000): Promise<string> {
  const resolved = resolveCmd("gemini");
  return new Promise((resolve, reject) => {
    const proc = spawn(resolved, ["-p", prompt, "-o", "text"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      reject(new Error("Gemini CLI timed out"));
    }, timeoutMs);

    proc.stdout.on("data", (d: Buffer) => { stdout += d; });
    proc.stderr.on("data", (d: Buffer) => { stderr += d; });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`gemini exited ${code}: ${stderr.slice(0, 300)}`));
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.end();
  });
}

export function generateTaskRoutes(): Router {
  const router = Router();

  // POST /api/generate-task — generate a first task using local Gemini CLI
  router.post("/", async (req, res) => {
    const {
      companyName,
      companyDescription,
      goals,
      agents,
      workspaceScan,
      linearTeamKey,
      linearIssueCount,
    } = req.body as {
      companyName?: string;
      companyDescription?: string;
      goals?: string[];
      agents?: Array<{ name: string; role: string; title?: string }>;
      workspaceScan?: {
        projectName?: string;
        languages?: string[];
        frameworks?: string[];
        scripts?: string[];
      };
      linearTeamKey?: string;
      linearIssueCount?: number;
    };

    // Build context for the prompt
    const sections: string[] = [];

    if (companyName) sections.push(`Company: ${companyName}`);
    if (companyDescription) sections.push(`Description: ${companyDescription}`);

    if (goals?.length) {
      sections.push(`Goals:\n${goals.map((g) => `  - ${g}`).join("\n")}`);
    }

    if (agents?.length) {
      const agentLines = agents.map((a) =>
        `  - ${a.name} (${a.role}${a.title ? `, ${a.title}` : ""})`
      );
      sections.push(`Team (${agents.length} agents):\n${agentLines.join("\n")}`);
    }

    if (workspaceScan) {
      const parts: string[] = [];
      if (workspaceScan.projectName) parts.push(`Project: ${workspaceScan.projectName}`);
      if (workspaceScan.languages?.length) parts.push(`Languages: ${workspaceScan.languages.join(", ")}`);
      if (workspaceScan.frameworks?.length) parts.push(`Frameworks: ${workspaceScan.frameworks.join(", ")}`);
      if (parts.length) sections.push(`Workspace:\n  ${parts.join("\n  ")}`);
    }

    if (linearTeamKey) {
      sections.push(`Linear team: ${linearTeamKey}${linearIssueCount ? ` (${linearIssueCount} open issues)` : ""}`);
    }

    const context = sections.join("\n\n");

    const prompt = `You are helping set up an AI agent company. Based on the following context, generate the FIRST task that the CEO agent should work on after launch.

${context}

The task should be specific to THIS company — not generic. It should reference the actual team members, goals, and tools available.

The CEO agent will receive this task and use it to kick off the company's work. The CEO creates approval requests for the board (human) to review before taking action.

Return ONLY a JSON object with exactly two fields, no other text:
{
  "title": "Short task title (under 80 chars)",
  "description": "Multi-line markdown description with numbered steps. Reference specific agent names and roles. Include the approval request step."
}`;

    try {
      const raw = await runGemini(prompt);

      // Parse JSON from response
      let parsed: { title: string; description: string };
      try {
        parsed = JSON.parse(raw);
      } catch {
        const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        if (fenced) {
          parsed = JSON.parse(fenced[1].trim());
        } else {
          const start = raw.indexOf("{");
          const end = raw.lastIndexOf("}");
          if (start !== -1 && end > start) {
            parsed = JSON.parse(raw.slice(start, end + 1));
          } else {
            throw new Error("No JSON found in response");
          }
        }
      }

      if (!parsed.title || !parsed.description) {
        throw new Error("Missing title or description");
      }

      res.json({
        title: parsed.title,
        description: parsed.description,
        model: "gemini-3-flash-preview",
      });
    } catch (err) {
      console.warn("[generate-task] Gemini failed:", err instanceof Error ? err.message : err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to generate task",
      });
    }
  });

  return router;
}
