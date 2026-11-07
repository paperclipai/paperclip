import { t as finalPagesT } from "@/i18n";
import { useTranslation } from "@/i18n";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type ChatEndpointSetupAction,
} from "@/api/chatEndpoints";
import { sanitizedSetupErrorMessage } from "./chat-setup-error";

export function PhotonConnectStep({
  endpoint,
  agentName,
  repairing,
  pending,
  onAction,
}: {
  endpoint: ChatEndpoint;
  agentName: string;
  repairing: boolean;
  pending: boolean;
  onAction(
    action: ChatEndpointSetupAction,
    values?: Record<string, string>,
  ): void;
}) {
  const { t } = useTranslation("connections");
  const [projectId, setProjectId] = useState(endpoint.providerAccountId ?? "");
  const [projectSecret, setProjectSecret] = useState("");
  const [lineId, setLineId] = useState("");
  const inspection = useMutation({
    mutationFn: () =>
      chatEndpointsApi.inspectPhoton(endpoint.id, {
        projectId: projectId.trim(),
        projectSecret,
      }),
    onSuccess: (result) => {
      const eligible = result.lines.filter((line) => line.eligible);
      setLineId(eligible.length === 1 ? eligible[0].lineId : "");
    },
  });
  const resetInspection = () => {
    inspection.reset();
    setLineId("");
  };
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-xl font-bold">{t("connect_imessage_photon_8a28191")}</h1>
        <p className="text-sm text-muted-foreground">{t("connect_to_photon_cloud_pro_supports_direct_fba8898", { agentName: agentName })}</p>
        <p className="text-sm">
          <a
            className="underline"
            href="https://app.photon.codes/"
            target="_blank"
            rel="noreferrer"
          >{t("photon_dashboard_903dc64")}</a>
          {" · "}
          <a
            className="underline"
            href="https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing"
            target="_blank"
            rel="noreferrer"
          >{t("photon_line_setup_989996d")}</a>
        </p>
      </div>
      {repairing && (
        <p className="text-sm text-muted-foreground">{t("reconnect_keeps_this_project_and_leave_the_b4d0b1e", { allocation: endpoint.photonAllocation === "shared" ? t("reviewBSharedDm") : endpoint.botExternalId ?? t("reviewBDedicatedNumber") })}</p>
      )}
      <label className="grid gap-2 text-sm font-medium">{t("project_id_3b91fb5")}<Input
          value={projectId}
          autoComplete="off"
          disabled={pending || inspection.isPending || !!endpoint.botExternalId}
          onChange={(event) => {
            setProjectId(event.target.value);
            resetInspection();
          }}
        />
      </label>
      <label className="grid gap-2 text-sm font-medium">{t("project_secret_0d88239")}<Input
          type="password"
          value={projectSecret}
          autoComplete="new-password"
          disabled={pending || inspection.isPending}
          onChange={(event) => {
            setProjectSecret(event.target.value);
            resetInspection();
          }}
        />
      </label>
      <Button
        variant="outline"
        disabled={
          pending || inspection.isPending || !projectId.trim() || !projectSecret
        }
        onClick={() => inspection.mutate()}
      >
        {inspection.isPending ? t("inspecting_photon_6ca082d") : t("inspect_photon_project_e3fd417")}
      </Button>
      {inspection.error ? (
        <p role="alert" className="text-sm text-destructive">
          {sanitizedSetupErrorMessage(inspection.error, { projectSecret })}
        </p>
      ) : null}
      {inspection.data && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">
            {finalPagesT("final-pages:allocation_in_project_906bd0", { allocation: inspection.data.allocation === "shared" ? t("shared_dms_f537dcb") : t("dedicated_numbers_37ff485"), project: inspection.data.projectName })}
          </legend>
          {!inspection.data.eligible && (
            <p role="alert" className="text-sm text-destructive">
              {inspection.data.allocation === "shared"
                ? t("this_shared_project_already_belongs_to_another_b56f1ed")
                : t("no_eligible_dedicated_number_is_available_check_53ae43f")}
            </p>
          )}
          {inspection.data.allocation === "shared" && inspection.data.eligible && (
            <p className="text-sm text-muted-foreground">{t("direct_messages_only_enroll_each_test_sender_5f11254")}</p>
          )}
          {inspection.data.lines.map((line) => (
            <label
              key={line.lineId}
              className="flex items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="photon-line"
                value={line.lineId}
                checked={lineId === line.lineId}
                disabled={
                  !line.eligible ||
                  pending ||
                  (!!endpoint.botExternalId &&
                    endpoint.botExternalId !== line.phoneNumber)
                }
                onChange={() => setLineId(line.lineId)}
              />
              <span>
                {line.phoneNumber}
                {line.unavailableReason ? ` — ${line.unavailableReason}` : ""}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div>
        <Button
          disabled={
            pending ||
            inspection.isPending ||
            (!(inspection.data?.eligible && (inspection.data.allocation === "shared" || lineId)) && !(repairing && !projectSecret))
          }
          onClick={() =>
            onAction(
              repairing ? "reconnect" : "configure",
              inspection.data?.eligible && inspection.data.allocation === "shared"
                ? { projectId: projectId.trim(), projectSecret, allocation: "shared" }
                : lineId
                ? { projectId: projectId.trim(), projectSecret, lineId, allocation: "dedicated" }
                : undefined,
            )
          }
        >
          {pending
            ? t("connecting_fd3e796")
            : repairing
              ? t("reconnect_photon_4ac5a5e")
              : inspection.data?.allocation === "shared" ? t("connect_shared_dms_a8b5625") : t("connect_selected_number_961427b")}
        </Button>
      </div>
    </div>
  );
}
