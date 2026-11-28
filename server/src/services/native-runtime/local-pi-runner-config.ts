import { homedir } from "node:os";

/** Only the server operator can bind their host Pi profile to an agent. */
export function operatorLocalPiConfig(companyId: string, agentId: string): string | undefined {
  const raw = process.env.PAPERCLIP_RUNNER_LOCAL_PI;
  if (!raw || raw.length > 8192) return undefined;
  try {
    const scope = JSON.parse(raw);
    if (scope?.companyId !== companyId || scope.agentId !== agentId) return undefined;
  } catch {
    return undefined;
  }
  return JSON.stringify({
    companyId,
    agentId,
    home: homedir(),
    path: process.env.PATH ?? "",
    profile: process.env.PI_CODING_AGENT_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  });
}
