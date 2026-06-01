import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

export interface AgentEnvFileLocator {
  id: string;
  companyId: string;
}

export function resolveAgentDir(agent: AgentEnvFileLocator): string {
  if (!PATH_SEGMENT_RE.test(agent.companyId)) {
    throw new Error(`Refusing to resolve agent dir for unsafe companyId '${agent.companyId}'`);
  }
  if (!PATH_SEGMENT_RE.test(agent.id)) {
    throw new Error(`Refusing to resolve agent dir for unsafe agentId '${agent.id}'`);
  }
  return path.resolve(
    resolvePaperclipInstanceRootForAdapter(),
    "companies",
    agent.companyId,
    "agents",
    agent.id,
  );
}

export function resolveAgentEnvFilePath(agent: AgentEnvFileLocator): string {
  return path.resolve(resolveAgentDir(agent), ".env");
}

export async function readAgentEnvFile(agent: AgentEnvFileLocator): Promise<Record<string, string>> {
  const filePath = resolveAgentEnvFilePath(agent);
  let contents: string;
  try {
    contents = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  return parseDotenv(contents);
}
