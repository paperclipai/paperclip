import { AccessStepContent } from "@/features/connections/ConnectionSetupFlow";
import { Footer } from "./shared";

const agents = [
  { id: "nova", name: "Nova" },
  { id: "atlas", name: "Atlas" },
];

/** Offline state adapter for the same access cards and agent picker used by Connectors. */
export function RoutingAccess({
  ownership,
  onOwnershipChange,
  allAgents,
  onAllAgentsChange,
  agentIds,
  onAgentIdsChange,
  fixedOwnership,
  disabled,
  hideFooter,
  onBack = () => {},
  onContinue = () => {},
}: {
  ownership: "personal" | "shared";
  onOwnershipChange: (value: "personal" | "shared") => void;
  allAgents: boolean;
  onAllAgentsChange: (value: boolean) => void;
  agentIds: Set<string>;
  onAgentIdsChange: (value: Set<string>) => void;
  fixedOwnership?: boolean;
  disabled?: boolean;
  hideFooter?: boolean;
  onBack?: () => void;
  onContinue?: () => void;
}) {
  return (
    <div className="space-y-6">
      <fieldset disabled={disabled} className="min-w-0">
        <AccessStepContent
          agents={agents}
          authKind="api_key"
          grantKind={ownership === "shared" ? "organization" : "user"}
          grantKinds={
            fixedOwnership
              ? [ownership === "shared" ? "organization" : "user"]
              : ["user", "organization"]
          }
          setGrantKind={(kind) =>
            onOwnershipChange(kind === "organization" ? "shared" : "personal")
          }
          installChoice={allAgents ? "all" : "specific"}
          setInstallChoice={(choice) => onAllAgentsChange(choice === "all")}
          installAgentIds={agentIds}
          setInstallAgentIds={onAgentIdsChange}
          submitLabel="Continue"
          onBack={onBack}
          onContinue={onContinue}
          hideFooter
          bare
        />
      </fieldset>
      {!hideFooter && (
        <Footer
          onBack={onBack}
          next="Continue"
          onNext={onContinue}
          disabled={disabled || (!allAgents && !agentIds.size)}
        />
      )}
    </div>
  );
}
