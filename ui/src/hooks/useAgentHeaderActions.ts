import { useEffect } from "react";
import type { Agent } from "@paperclipai/shared";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { AgentBulkActions } from "../components/AgentBulkActions";
import { createElement } from "react";

export function useAgentHeaderActions(agents: Agent[] | undefined, companyId: string | null) {
  const { setActions } = useBreadcrumbs();

  useEffect(() => {
    if (!agents || !companyId) {
      setActions(null);
      return;
    }
    setActions(createElement(AgentBulkActions, { agents, companyId }));
    return () => setActions(null);
  }, [agents, companyId, setActions]);
}
