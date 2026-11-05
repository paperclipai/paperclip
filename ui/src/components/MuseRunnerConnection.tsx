import { useTranslation } from "@/i18n";
import { describeError } from "@/api/errors";
import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { museDetectorCleanupAttestationSchema } from "@paperclipai/shared";
import type { MuseConnection, MusePairing, MuseAttestStopInput, MuseDetectorCleanupAttestationInput } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { useMuseConnection, useMuseConnectionState } from "@/hooks/useMuseConnection";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";
import { AgentSetupPrompt } from "./AgentSetupPrompt";
import { MuseConnectionChecks } from "./new-agent/ExternalAgentInviteContent";
import { Input } from "./ui/input";
import { Button } from "./ui/button";

export interface MuseConnectionDetailsProps {
  connection: MuseConnection;
  pairing?: MusePairing | null;
  busy?: boolean;
  error?: string;
  offline?: boolean;
  onTest: () => void;
  onRepair: () => void;
  onPause: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
  onAttest: (input: MuseAttestStopInput) => void;
  onAttestDetectorCleanup?: (input: MuseDetectorCleanupAttestationInput) => void;
}

/** The settings view uses the same connection evidence as the invitation. */
export function MuseConnectionDetails({ connection, pairing, busy, error, offline = false, onTest, onRepair, onPause, onDisconnect, onRefresh, onAttest, onAttestDetectorCleanup }: MuseConnectionDetailsProps) {
  const { t } = useTranslation("connections");
  const b = connection.binding;
  const [attestation, setAttestation] = useState<MuseAttestStopInput | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [detectorSnapshot, setDetectorSnapshot] = useState<Omit<MuseDetectorCleanupAttestationInput, "observation" | "detectorRemoved"> | null>(null);
  const [detectorHookId, setDetectorHookId] = useState("");
  const [observationDigest, setObservationDigest] = useState("");
  const [detectorObservedAt, setDetectorObservedAt] = useState("");
  const detectorObservedAtValid = museDetectorCleanupAttestationSchema.shape.observation.shape.observedAt.safeParse(detectorObservedAt).success;
  const [detectorConfirmed, setDetectorConfirmed] = useState(false);
  const detectorIdentity = JSON.stringify([b?.id, b?.generation, b?.revision, b?.qualification?.id, b?.cleanup.hookScript, b?.cleanup.attestationEligible, offline]);
  useEffect(() => { setDetectorSnapshot(null); setObservationDigest(""); setDetectorObservedAt(""); setDetectorHookId(""); setDetectorConfirmed(false); }, [detectorIdentity]);
  const boundaryIdentity = JSON.stringify(b?.stop.boundary);
  const stopBindingRevision = b?.stop.bindingRevision;
  useEffect(() => { setAttestation(null); setConfirmed(false); }, [boundaryIdentity, stopBindingRevision]);
  const live = !!b && b.status !== "revoked";
  const state = useMuseConnectionState(connection, { offline });
  const testing = state.testing;
  const configure = !offline && connection.enabled && connection.canConfigureConnection && !!connection.publicOrigin;
  const timestamp = (value: string | null) => value ? formatDateTime(value, { includeSeconds: true }) : t("not_observed_60ac631");
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{t("muse_uses_its_own_tools_and_permissions_6e200c2")}</p>
    {!connection.enabled && <p className="text-sm text-muted-foreground">{t("muse_is_disabled_in_experimental_settings_connection_3902395")}</p>}
    {!connection.publicOrigin && <p className="text-sm text-muted-foreground">{t("an_authenticated_instance_with_a_public_https_af62e1e")}</p>}
    {b && <>
      <MuseConnectionChecks state={state} />
      <dl className="space-y-2 text-xs">
        {[
          [t("last_persisted_public_receiver_contact_472ee62"), timestamp(b.lastReceiverContactAt)],
          [t("authenticated_worker_activity_ee7e564"), timestamp(b.lastWorkerActivityAt)],
          [t("last_verified_reply_08b059c"), timestamp(b.lastVerifiedReplyAt)],
          [t("credential_status_d99dee0"), b.credentialState],
          [t("refresh_credential_expires_34a3ba4"), timestamp(b.refreshExpiresAt)],
          [t("client_version_0efe543"), b.clientVersion ?? t("not_reported_98e8568")],
          [t("live_assignments_f05d531"), String(b.liveAssignments)],
          [t("uncertain_native_operations_c0ada23"), String(b.uncertainOperations)],
          [t("pending_answers_df49a27"), String(b.pendingInputs)],
          [t("usage_and_cost_a94af0e"), t("unavailable_2c9c1f7")],
        ].map(([label, value]) => <div key={label} className="flex flex-wrap items-baseline justify-between gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="font-mono">{value}</dd></div>)}
      </dl>
      <p className="text-xs text-muted-foreground">{t("receiver_contact_is_persisted_in_batches_and_05d27f0", { value: Math.ceil(b.contactPersistenceLagMs / 1000) })}</p>
      {b.status === "revoked" && <p role="status" className="text-sm text-muted-foreground">{t("disconnected_paperclip_credentials_and_execution_authority_were_2321dcb")}</p>}
      {(b.cleanup.pending || b.status === "revoked") && <div className="space-y-2 text-sm text-muted-foreground">
        {"detectorRemovalRequested" in b.cleanup && b.cleanup.detectorRemovalRequested === true && !b.cleanup.detectorRemoved && <p>{t("detector_removal_requested_completion_is_not_confirmed_55fe151")}</p>}
        <p>{t("detector_removal_worker_quiescence_40dc8ec", { detectorStatus: b.cleanup.detectorEvidence?.source === "operator_runtime_attestation" ? t("reviewBOperatorAttested") : b.cleanup.detectorRemoved ? t("reviewBAcknowledged") : t("reviewBNotConfirmed"), workerStatus: b.cleanup.workerQuiescenceReported ? t("reviewBReported") : t("reviewBNotConfirmed") })}</p>
        {b.cleanup.authenticatedAfterRevocation === false && <p>{t("after_disconnect_the_receiver_disables_itself_when_2bf2de1")}</p>}
        {b.cleanup.expiresAt && <p className="text-xs">{t("cleanup_capability_expires_841a8a9", { value: formatDateTime(b.cleanup.expiresAt) })}</p>}
        {b.cleanup.detectorEvidence && <p>{t("recorded_this_is_not_independent_provider_confirmation_c2f10f6", { recordedAt: timestamp(b.cleanup.detectorEvidence.recordedAt), evidenceSource: b.cleanup.detectorEvidence.source === "operator_runtime_attestation" ? t("reviewBOperatorEvidence") : t("reviewBWorkerEvidence") })}</p>}
        {b.cleanup.attestationEligible && onAttestDetectorCleanup && !detectorSnapshot && <Button type="button" variant="outline" disabled={busy || offline} onClick={() => {
          if (!b.cleanup.hookScript) return;
          setDetectorSnapshot({ bindingId: b.id, generation: b.generation, expectedRevision: b.revision, qualificationId: b.qualification?.id ?? null, hookScript: b.cleanup.hookScript });
        }}>{t("record_detector_removal_observation_6d2319b")}</Button>}
        <p>{t("detector_removal_worker_stopping_and_sandbox_cleanup_82eb3c4")}</p>
      </div>}
      {b.stop.status !== "none" && <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{b.stop.status === "operator_attested" ? t("you_attested_that_this_assignment_s_muse_8d03398")
          : b.stop.status === "worker_reported" ? t("muse_reported_that_this_assignment_s_worker_3684360")
          : t("paperclip_fenced_this_assignment_s_authority_its_4f73313")}</p>
        {b.stop.nativeEffectsUnknown && <p role="status" className="text-muted-foreground">{t("native_effect_outcomes_remain_unknown_and_block_6cde08b")}</p>}
        {b.stop.boundary && stopBindingRevision == null && b.stop.status !== "operator_attested" && <p role="status" className="text-muted-foreground">{t("stop_binding_revision_is_unavailable_refresh_to_7244c35")}</p>}
        {b.stop.boundary && b.stop.status !== "operator_attested" && !attestation && <Button type="button" variant="outline" disabled={busy || stopBindingRevision == null} onClick={() => {
          if (!b.stop.boundary || stopBindingRevision == null) return;
          setAttestation({ boundary: { ...b.stop.boundary }, expectedRevision: stopBindingRevision, workerStopped: true }); setConfirmed(false);
        }}>{t("attest_this_worker_stopped_598fcc3")}</Button>}
      </div>}
    </>}
    {detectorSnapshot && <section aria-label={t("record_exact_muse_detector_removal_0016051")} className="space-y-3 rounded-md border border-border p-3">
      <p className="text-sm font-medium">{t("record_an_observation_of_this_exact_detector_d550d54")}</p>
      <p className="break-all font-mono text-xs">{detectorSnapshot.hookScript}</p>
      <p className="text-sm text-muted-foreground">{t("use_muse_s_supported_5f6520f")}<code>{"hooks.list({ include_disabled: true })"}</code>{t("after_revocation_to_verify_this_exact_registered_bb998ab")}</p>
      <label className="block space-y-2 text-sm">{t("registered_hook_id_90c1bab")}<Input aria-label={t("registered_muse_hook_id_a6eea33")} value={detectorHookId} onChange={event => { setDetectorHookId(event.target.value); setDetectorConfirmed(false); }} autoComplete="off" /></label>
      <label className="block space-y-2 text-sm">{t("observation_sha_256_8630a04")}<Input aria-label={t("detector_removal_observation_sha_256_6f80f9e")} value={observationDigest} onChange={event => { setObservationDigest(event.target.value); setDetectorConfirmed(false); }} autoComplete="off" /></label>
      <p className="text-xs text-muted-foreground">{t("use_the_digest_of_the_secret_free_451853c")}</p>
      <label className="block space-y-2 text-sm">{t("observed_at_utc_1413986")}<Input aria-label={t("detector_removal_observed_at_utc_0697114")} value={detectorObservedAt} onChange={event => { setDetectorObservedAt(event.target.value); setDetectorConfirmed(false); }} placeholder="YYYY-MM-DDTHH:mm:ss.sssZ" autoComplete="off" /></label>
      <p className="text-xs text-muted-foreground">{t("enter_the_actual_runtime_listing_time_not_2a26df7")}</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={detectorConfirmed} onChange={event => setDetectorConfirmed(event.target.checked)} className="mt-1 accent-primary" /><span>{t("i_observed_this_exact_hook_absent_in_8db0fc9")}</span></label>
      <div className="flex items-center justify-between gap-3"><Button type="button" variant="ghost" onClick={() => setDetectorSnapshot(null)}>{t("cancel_77dfd21")}</Button><Button type="button" disabled={!detectorConfirmed || !detectorObservedAtValid || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(detectorHookId) || !/^[a-f0-9]{64}$/.test(observationDigest) || busy || offline} onClick={() => onAttestDetectorCleanup?.({ ...detectorSnapshot, detectorRemoved: true, observation: { method: "hooks.list", includeDisabled: true, hookId: detectorHookId, outcome: "exact_hook_absent", observedAt: detectorObservedAt, sha256: observationDigest } })}>{t("confirm_detector_observation_0fd2312")}</Button></div>
    </section>}
    {attestation && <section aria-label={t("attest_this_muse_worker_stopped_b720e05")} className="space-y-3 rounded-md border border-border p-3">
      <p className="text-sm font-medium">{t("confirm_the_worker_for_this_exact_assignment_14f1129")}</p>
      <dl className="space-y-2 text-xs">
        {Object.entries(attestation.boundary).map(([key, value]) => <div key={key} className="flex flex-wrap items-baseline justify-between gap-2"><dt className="text-muted-foreground">{key}</dt><dd className="break-all font-mono">{value === null ? t("none_6eef664") : String(value)}</dd></div>)}
      </dl>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 accent-primary" /><span>{t("i_have_stopped_this_muse_worker_for_968fb49")}</span></label>
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={() => setAttestation(null)}>{t("cancel_77dfd21")}</Button>
        <Button type="button" disabled={!confirmed || busy} onClick={() => onAttest(attestation)}>{t("confirm_worker_stopped_1776e4a")}</Button>
      </div>
    </section>}
    {pairing && !b?.paired && <div className="space-y-2">
      <AgentSetupPrompt key={pairing.bindingId + pairing.revision} prompt={pairing.setupInstruction} label={t("copy_setup_prompt_c42e185")} title={t("connect_your_muse_3b75833")} agent={{ name: "Muse", icon: <Bot className="size-5" /> }} description={t("paste_into_your_current_muse_conversation_complete_6944e83")} />
      <p className="text-xs text-muted-foreground">{t("one_use_setup_expires_muse_keeps_the_c5b6efa", { value: formatDateTime(pairing.expiresAt) })}</p>
    </div>}
    <div className="flex flex-wrap items-center gap-2">
      {live && <Button type="button" variant="outline" disabled={!configure || b.credentialState !== "active" || !b.paired || busy || testing} onClick={onTest}>{testing ? t("testing_background_reply_6717220") : t("test_background_reply_66e9f89")}</Button>}
      <Button type="button" variant="outline" disabled={!configure || busy} onClick={onRepair}>{b?.credentialState === "expired" ? t("reconnect_muse_5749432") : live ? t("repair_connection_3de121b") : t("connect_muse_589e849")}</Button>
      {connection.agentStatus !== "paused" && connection.agentStatus !== "terminated" && <Button type="button" variant="outline" disabled={busy} onClick={onPause}>{t("pause_agent_896172c")}</Button>}
      {live && <Button type="button" variant="outline" disabled={busy} onClick={onDisconnect}>{t("disconnect_ed28e06")}</Button>}
      <Button type="button" variant="ghost" disabled={busy} onClick={onRefresh}>{t("refresh_56e3bad")}</Button>
      <Button type="button" asChild variant="ghost"><a href="https://muse.ai" target="_blank" rel="noopener noreferrer">{t("open_muse_ddc100d")}</a></Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}

export function MuseRunnerConnection({ companyId, agentId }: { companyId?: string; agentId?: string }) {
  const { t } = useTranslation("connections");
  const cache = useQueryClient();
  const muse = useMuseConnection(companyId, agentId);
  const pause = useMutation({ mutationFn: () => agentsApi.pause(agentId!, companyId), onSuccess: () => {
    void muse.refresh(); void cache.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId!) });
    if (companyId) void cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
  } });
  if (!agentId) return <p className="text-sm text-muted-foreground">{t("save_the_agent_then_connect_your_personal_a94b0a6")}</p>;
  const error = muse.state.error ?? muse.pair.error ?? muse.verify.error ?? muse.revoke.error ?? muse.attest.error ?? muse.attestDetector.error ?? pause.error;
  if (muse.identity.failed) return <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{t("unable_to_confirm_your_account_refresh_to_772270e")}</p><Button type="button" variant="outline" onClick={() => { void cache.invalidateQueries({ queryKey: queryKeys.auth.session }); }}>{t("refresh_56e3bad")}</Button></div>;
  if (!muse.state.data) return <div className="space-y-3"><p role="status" className="text-sm text-muted-foreground">{muse.state.error ? t("unable_to_load_the_muse_connection_38a57bf") : t("loading_muse_connection_a4c99a7")}</p>{error && <p role="alert" className="text-sm text-destructive">{describeError(error).body}</p>}<Button type="button" variant="outline" onClick={() => { void muse.state.refetch(); }}>{t("refresh_56e3bad")}</Button></div>;
  return <MuseConnectionDetails key={muse.identity.userId} connection={muse.state.data} pairing={muse.pairing} offline={muse.state.isError}
    busy={muse.pair.isPending || muse.verify.isPending || muse.revoke.isPending || muse.attest.isPending || muse.attestDetector.isPending || pause.isPending}
    error={error ? describeError(error).body : undefined} onTest={() => { if (muse.binding) muse.verify.mutate(muse.binding); }} onRepair={muse.repair}
    onPause={() => pause.mutate()} onDisconnect={() => { if (muse.binding) muse.revoke.mutate(muse.binding); }}
    onRefresh={() => { void muse.state.refetch(); }} onAttest={input => muse.attest.mutate(input)} onAttestDetectorCleanup={input => muse.attestDetector.mutate(input)} />;
}
