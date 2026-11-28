import type { AgentDetail as AgentDetailRecord } from "@paperclipai/shared";
import { AuditFeed } from "./audit/AuditFeed";
import { AuditRuns } from "./audit/AuditRuns";
import { AgentBudgetsPanel } from "./AgentBudgetsPanel";
import { AgentCostsPanel } from "./AgentCostsPanel";
import type { AgentAuditView } from "./agent-detail-navigation";

export function AgentAuditTab({
  agent,
  companyId,
  section,
}: {
  agent: AgentDetailRecord;
  companyId: string;
  section: AgentAuditView;
}) {
  if (section === "activity") return <AuditFeed companyId={companyId} lockedAgentId={agent.id} hideHeader />;
  if (section === "runs") return <AuditRuns companyId={companyId} lockedAgentId={agent.id} hideHeader />;
  if (section === "costs") return <AgentCostsPanel agentId={agent.id} agentName={agent.name} companyId={companyId} />;
  return <AgentBudgetsPanel agent={agent} companyId={companyId} />;
}
