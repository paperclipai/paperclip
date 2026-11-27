import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const agentConfigPanelClassName = "space-y-3 rounded-lg bg-(--agent-detail-tile) p-(--agent-detail-module-inset)";

export function AgentConfigPanel({ children, panel = true, className, section }: {
  children: ReactNode;
  panel?: boolean;
  className?: string;
  section?: string;
}) {
  return <div data-agent-tile={panel ? "" : undefined} data-config-section={section}
    className={cn(panel && agentConfigPanelClassName, className)}>{children}</div>;
}

export function HarnessConfigPanels({ identity, runtime }: { identity: ReactNode; runtime: ReactNode }) {
  return <div className="grid grid-cols-1 gap-(--agent-detail-module-gap) @2xl:grid-cols-2">
    <AgentConfigPanel section="adapter">{identity}</AgentConfigPanel>
    <AgentConfigPanel section="configuration">{runtime}</AgentConfigPanel>
  </div>;
}
