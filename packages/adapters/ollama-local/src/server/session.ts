import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PAPERCLIP_SESSIONS_DIR = path.join(os.homedir(), ".paperclip", "ollama-sessions");

export interface OllamaSessionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: unknown[];
  tool_name?: string;
}

export interface OllamaSessionState {
  agentId: string;
  cwd: string;
  model: string;
  host: string;
  cloud: boolean;
  messages: OllamaSessionMessage[];
  createdAt: string;
  updatedAt: string;
}

export async function ensureSessionsDir(): Promise<string> {
  await fs.mkdir(PAPERCLIP_SESSIONS_DIR, { recursive: true });
  return PAPERCLIP_SESSIONS_DIR;
}

export function buildSessionPath(agentId: string, timestamp: string): string {
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.join(PAPERCLIP_SESSIONS_DIR, `${safeTimestamp}-${safeAgent}.json`);
}

export async function loadSession(sessionPath: string): Promise<OllamaSessionState | null> {
  try {
    const raw = await fs.readFile(sessionPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<OllamaSessionState>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) return null;
    return parsed as OllamaSessionState;
  } catch {
    return null;
  }
}

export async function saveSession(sessionPath: string, state: OllamaSessionState): Promise<void> {
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  const payload = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  // Atomic write: write to temp, then rename. Avoids torn state on crash.
  const tmp = `${sessionPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, sessionPath);
}

export function sessionMatchesCurrentRun(
  state: OllamaSessionState,
  current: { cwd: string; model: string; host: string },
): boolean {
  return (
    path.resolve(state.cwd) === path.resolve(current.cwd) &&
    state.model === current.model &&
    state.host === current.host
  );
}
