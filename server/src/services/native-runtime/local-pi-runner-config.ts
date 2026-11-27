/** Only the server operator can bind their host Pi profile to an agent. */
export function operatorLocalPiConfig(companyId: string, agentId: string): string | undefined {
  const raw = process.env.PAPERCLIP_RUNNER_LOCAL_PI;
  if (!raw || raw.length > 8192) return undefined;
  try {
    const scope = JSON.parse(raw);
    return scope?.companyId === companyId && scope.agentId === agentId ? raw : undefined;
  } catch {
    return undefined;
  }
}
