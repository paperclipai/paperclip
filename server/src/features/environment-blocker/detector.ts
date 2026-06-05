export interface EnvironmentBlockerResult {
  found: boolean;
  resource: string;
  ownerType: "CTO" | "CEO";
}

const BLOCKER_PATTERN =
  /blocked\s+until:\s*([a-z0-9\s\/\-,]+?)\s+(?:is\s+)?(?:access\s+)?(?:available|provisioned)/i;

const CTO_RESOURCE_PATTERN =
  /\b(mt5|mt4|vps|cloud|terraform|infra|infrastructure|network|docker|k8s|kubernetes|database|db|server|broker\s+api|api\s+key|rdp|ssh)\b/i;

export function detectEnvironmentBlocker(description: string): EnvironmentBlockerResult {
  const match = BLOCKER_PATTERN.exec(description);
  if (!match) {
    return { found: false, resource: "", ownerType: "CEO" };
  }

  const resource = match[1].trim();
  const ownerType = CTO_RESOURCE_PATTERN.test(resource) ? "CTO" : "CEO";
  return { found: true, resource, ownerType };
}
