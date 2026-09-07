import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { AgentBasicsDialog } from "./new-agent/AgentBasicsDialog";

export function NewAgentDialog() {
  const { newAgentOpen, closeNewAgent } = useDialog();
  const navigate = useNavigate();
  if (!newAgentOpen) return null;
  return (
    <AgentBasicsDialog
      open
      onClose={closeNewAgent}
      onContinue={(basics) => {
        closeNewAgent();
        navigate(`/agents/new?${new URLSearchParams(basics)}`);
      }}
    />
  );
}
