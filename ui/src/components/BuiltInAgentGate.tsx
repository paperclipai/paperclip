import type { ReactNode } from "react";
import { Bot } from "lucide-react";
import { ApiError } from "@/api/client";
import { EmptyState } from "@/components/EmptyState";

interface BuiltInAgentGateProps {
  agentKey: string;
  companyId: string | null | undefined;
  featureLabel?: string;
  error?: unknown;
  children?: ReactNode;
}

function isBuiltInAgentPrecondition(error: unknown, agentKey: string) {
  if (!(error instanceof ApiError) || error.status !== 412) return false;
  const body = error.body as { code?: unknown; details?: { key?: unknown } } | null;
  if (body?.code !== "built_in_agent_not_configured") return false;
  return body.details?.key == null || body.details.key === agentKey;
}

export function BuiltInAgentGate({ agentKey, companyId, featureLabel, error, children }: BuiltInAgentGateProps) {
  const label = featureLabel ?? agentKey;

  if (!companyId) {
    return <EmptyState icon={Bot} title={`${label} unavailable`} message="Select a company to continue." />;
  }

  if (isBuiltInAgentPrecondition(error, agentKey)) {
    return (
      <EmptyState
        icon={Bot}
        title={`${label} agent unavailable`}
        message={`${label} needs a configured ${agentKey} agent before briefs can load.`}
      />
    );
  }

  return <>{children}</>;
}
