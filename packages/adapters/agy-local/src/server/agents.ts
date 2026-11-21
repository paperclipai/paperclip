import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

export interface AgyAgentProfile {
  id: string;
  label: string;
  description?: string;
}

export function parseAgyAgentsOutput(output: string): AgyAgentProfile[] {
  const agents: AgyAgentProfile[] = [];
  const lines = output.split(/\r?\n/);

  for (const rawLine of lines) {
    const cleanLine = rawLine
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
      .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "")
      .trim();

    if (!cleanLine || cleanLine.toLowerCase().startsWith("available agents")) {
      continue;
    }

    const match = cleanLine.match(/^([a-zA-Z0-9_.-]+)(?:\s{2,}(.+))?$/) || cleanLine.match(/^([a-zA-Z0-9_.-]+)(?:\s+(.+))?$/);
    if (match) {
      const id = match[1]!.trim();
      const desc = match[2]?.trim();
      if (id && !agents.some((a) => a.id === id)) {
        agents.push({
          id,
          label: desc ? `${id} (${desc})` : id,
          ...(desc ? { description: desc } : {}),
        });
      }
    }
  }

  return agents;
}

export async function listAgyAgents(command = "agy"): Promise<AgyAgentProfile[]> {
  try {
    const runId = `agy-agents-${Date.now()}`;
    const proc = await runChildProcess(runId, command, ["agents"], {
      cwd: process.cwd(),
      env: Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
      ),
      timeoutSec: 15,
      graceSec: 3,
      onLog: async () => {},
    });

    if (proc.exitCode === 0 && proc.stdout.trim().length > 0) {
      return parseAgyAgentsOutput(proc.stdout);
    }
  } catch {
    // Probing unavailable
  }

  return [];
}
