import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CloudTrialInferenceStatus } from "@paperclipai/shared";
import { cloudInferenceApi } from "@/api/cloud-inference";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { CloudTrialExhaustedModal } from "@/components/CloudTrialExhaustedModal";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Global shell controller that watches the selected company's Cloud starter
 * inference status and requires connecting a model provider when needed.
 */
export function CloudTrialGate() {
  const { selectedCompanyId } = useCompany();
  const [dismissedAfterMigration, setDismissedAfterMigration] = useState(false);
  // Keep the modal mounted on its "Subscription connected" confirmation screen
  // after migration flips `status` to "migrated" and empties `trialAgentIds`,
  // until the user explicitly clicks "Continue to workspace".
  const [holdingMigrationSuccess, setHoldingMigrationSuccess] = useState(false);
  const [migrationComplete, setMigrationComplete] = useState(false);
  const [lastExhaustedStatus, setLastExhaustedStatus] = useState<CloudTrialInferenceStatus | null>(null);

  const experimental = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: instanceSettingsApi.getExperimental,
  });

  const enabled = experimental.data?.enableCloudTrialInference === true;

  const statusQuery = useQuery({
    queryKey: queryKeys.cloudInference.status(selectedCompanyId ?? "__none__"),
    queryFn: () => cloudInferenceApi.getStatus(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && enabled,
    staleTime: 15_000,
  });

  const status = statusQuery.data;
  const isExhaustedWithTrialAgents =
    Boolean(selectedCompanyId) &&
    enabled &&
    status?.status === "exhausted" &&
    status.trialAgentIds.length > 0;

  useEffect(() => {
    if (isExhaustedWithTrialAgents && status) {
      setLastExhaustedStatus(status);
    }
  }, [isExhaustedWithTrialAgents, status]);

  useEffect(() => {
    setDismissedAfterMigration(false);
    setHoldingMigrationSuccess(false);
    setMigrationComplete(false);
    setLastExhaustedStatus(null);
  }, [selectedCompanyId]);

  const modalStatus = isExhaustedWithTrialAgents ? status : lastExhaustedStatus;
  const shouldShowModal =
    Boolean(selectedCompanyId) &&
    Boolean(modalStatus) &&
    !dismissedAfterMigration &&
    (isExhaustedWithTrialAgents || holdingMigrationSuccess);

  if (!selectedCompanyId || !modalStatus || !shouldShowModal) {
    return null;
  }

  return (
    <CloudTrialExhaustedModal
      open={shouldShowModal}
      companyId={selectedCompanyId}
      status={modalStatus}
      required={!migrationComplete && modalStatus.canMigrate !== false}
      onOpenChange={(open) => {
        if (!open) {
          setHoldingMigrationSuccess(false);
          setMigrationComplete(false);
          setDismissedAfterMigration(true);
        }
      }}
      onMigrationStart={() => {
        // Lock the modal open BEFORE POST /migrate fires so the server's
        // WebSocket `cloud_trial.status.updated` event cannot unmount the
        // dialog before the confirmation screen renders.
        setHoldingMigrationSuccess(true);
      }}
      onMigrated={() => {
        setHoldingMigrationSuccess(true);
        setMigrationComplete(true);
      }}
    />
  );
}
