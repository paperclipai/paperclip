import { Bot, Compass } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { usePrimaryAgentPresentation } from "@/components/primary-agent/PrimaryAgentPresentation";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";

/** Nothing owned and nothing proposed yet: add a responsibility, or ask the primary agent to draft them. */
export function ResponsibilitiesEmpty({ companyId, onAdd }: { companyId: string; onAdd: () => void }) {
  const primary = usePrimaryAgentPresentation(companyId);
  const agent = primary?.primaryAgent ?? null;
  return (
    <div className="flex flex-col items-center gap-2">
      <EmptyState
        icon={Compass}
        title="What do you own?"
        message="A responsibility is something you own, with a bar for success and a number that shows whether you are meeting it. Group them under the areas you care about, such as Fundraising or Hiring."
        action="Add a responsibility"
        onAction={onAdd}
      />
      {agent ? (
        <Button asChild variant="ghost">
          <Link to={`/chats/${encodeURIComponent(agentRouteRef(agent))}`}>
            <Bot aria-hidden="true" />
            Ask {agent.name} to draft them
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
