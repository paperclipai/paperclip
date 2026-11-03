import { externalRunnerStatusLabel } from "@/lib/external-runner-labels";
import { Trans } from "react-i18next";
import { t, useTranslation } from "@/i18n";
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
  useTranslation();
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
  const timestamp = (value: string | null) => value ? formatDateTime(value, { includeSeconds: true }) : t("oct19Voice.notObserved_b5c68i");
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{t("oct19Voice.museUsesItsOwnToolsAnd_fssv6r")}</p>
    {!connection.enabled && <p className="text-sm text-muted-foreground">{t("oct19Voice.museIsDisabledInExperimentalSettings_1fdk1tg")}</p>}
    {!connection.publicOrigin && <p className="text-sm text-muted-foreground">{t("oct19Voice.anAuthenticatedInstanceWithAPublic_zyc0sw")}</p>}
    {b && <>
      <MuseConnectionChecks state={state} />
      <dl className="space-y-2 text-xs">
        {[
          [t("oct19Voice.lastPersistedPublicReceiverContact_z1ytbm"), timestamp(b.lastReceiverContactAt)],
          [t("oct19Voice.authenticatedWorkerActivity_532233"), timestamp(b.lastWorkerActivityAt)],
          [t("oct19Voice.lastVerifiedReply_1gdcevr"), timestamp(b.lastVerifiedReplyAt)],
          [t("oct19Voice.credentialStatus_y2v5hm"), externalRunnerStatusLabel(b.credentialState)],
          [t("oct19Voice.refreshCredentialExpires_vyaq09"), timestamp(b.refreshExpiresAt)],
          [t("oct19Voice.clientVersion_1yvckme"), b.clientVersion ?? t("oct19Voice.notReported_13eh6jh")],
          [t("oct19Voice.liveAssignments_1ldnxfl"), String(b.liveAssignments)],
          [t("oct19Voice.uncertainNativeOperations_1ejiq7"), String(b.uncertainOperations)],
          [t("oct19Voice.pendingAnswers_y3edf3"), String(b.pendingInputs)],
          [t("oct19Voice.usageAndCost_1j1un6i"), t("oct19Voice.unavailable_1okhrqh")],
        ].map(([label, value]) => <div key={label} className="flex flex-wrap items-baseline justify-between gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="font-mono">{value}</dd></div>)}
      </dl>
      <p className="text-xs text-muted-foreground">{t("oct19Voice.receiverLag", { count: Math.ceil(b.contactPersistenceLagMs / 1000) })}</p>
      {b.status === "revoked" && <p role="status" className="text-sm text-muted-foreground">{t("oct19Voice.disconnectedPaperclipCredentialsAndExecutionAuthority_c2jwqz")}</p>}
      {(b.cleanup.pending || b.status === "revoked") && <div className="space-y-2 text-sm text-muted-foreground">
        {"detectorRemovalRequested" in b.cleanup && b.cleanup.detectorRemovalRequested === true && !b.cleanup.detectorRemoved && <p>{t("oct19Voice.detectorRemovalRequestedCompletionIsNot_1nrz5y8")}</p>}
        <p>{t("oct19Voice.cleanupStatus", { detector: b.cleanup.detectorEvidence?.source === "operator_runtime_attestation" ? t("oct19Voice.operatorAttested_jfqg64") : b.cleanup.detectorRemoved ? t("oct19Voice.acknowledged_e40kz9") : t("oct19Voice.notConfirmed_1stempb"), worker: b.cleanup.workerQuiescenceReported ? t("oct19Voice.reported_1a1jb1m") : t("oct19Voice.notConfirmed_1stempb") })}</p>
        {b.cleanup.authenticatedAfterRevocation === false && <p>{t("oct19Voice.afterDisconnectTheReceiverDisablesItself_zjcnpz")}</p>}
        {b.cleanup.expiresAt && <p className="text-xs">{t("oct19Voice.cleanupExpires", { time: formatDateTime(b.cleanup.expiresAt) })}</p>}
        {b.cleanup.detectorEvidence && <p>{t("oct19Voice.cleanupRecorded", { time: timestamp(b.cleanup.detectorEvidence.recordedAt), source: b.cleanup.detectorEvidence.source === "operator_runtime_attestation" ? t("oct19Voice.operatorAttestationFromASupportedRuntime_zhmzqz") : t("oct19Voice.authenticatedWorkerReport_hbc1uw") })}</p>}
        {b.cleanup.attestationEligible && onAttestDetectorCleanup && !detectorSnapshot && <Button type="button" variant="outline" disabled={busy || offline} onClick={() => {
          if (!b.cleanup.hookScript) return;
          setDetectorSnapshot({ bindingId: b.id, generation: b.generation, expectedRevision: b.revision, qualificationId: b.qualification?.id ?? null, hookScript: b.cleanup.hookScript });
        }}>{t("oct19Voice.recordDetectorRemovalObservation_ai3qhw")}</Button>}
        <p>{t("oct19Voice.detectorRemovalWorkerStoppingAndSandbox_bg3hjo")}</p>
      </div>}
      {b.stop.status !== "none" && <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{b.stop.status === "operator_attested" ? t("oct19Voice.youAttestedThatThisAssignmentS_ypa89h")
          : b.stop.status === "worker_reported" ? t("oct19Voice.museReportedThatThisAssignmentS_1kxyicu")
          : t("oct19Voice.paperclipFencedThisAssignmentSAuthority_14pqkjw")}</p>
        {b.stop.nativeEffectsUnknown && <p role="status" className="text-muted-foreground">{t("oct19Voice.nativeEffectOutcomesRemainUnknownAnd_rxdwy2")}</p>}
        {b.stop.boundary && stopBindingRevision == null && b.stop.status !== "operator_attested" && <p role="status" className="text-muted-foreground">{t("oct19Voice.stopBindingRevisionIsUnavailableRefresh_ul47j0")}</p>}
        {b.stop.boundary && b.stop.status !== "operator_attested" && !attestation && <Button type="button" variant="outline" disabled={busy || stopBindingRevision == null} onClick={() => {
          if (!b.stop.boundary || stopBindingRevision == null) return;
          setAttestation({ boundary: { ...b.stop.boundary }, expectedRevision: stopBindingRevision, workerStopped: true }); setConfirmed(false);
        }}>{t("oct19Voice.attestThisWorkerStopped_11teeev")}</Button>}
      </div>}
    </>}
    {detectorSnapshot && <section aria-label={t("oct19Voice.recordExactMuseDetectorRemoval_1vfzzg3")} className="space-y-3 rounded-md border border-border p-3">
      <p className="text-sm font-medium">{t("oct19Voice.recordAnObservationOfThisExact_1sayk29")}</p>
      <p className="break-all font-mono text-xs">{detectorSnapshot.hookScript}</p>
      <p className="text-sm text-muted-foreground"><Trans i18nKey="oct19Voice.detectorInstructions" components={{ code: <code /> }} /></p>
      <label className="block space-y-2 text-sm">{t("oct19Voice.registeredHookId_179qpnd")}<Input aria-label={t("oct19Voice.registeredMuseHookId_4ow0x9")} value={detectorHookId} onChange={event => { setDetectorHookId(event.target.value); setDetectorConfirmed(false); }} autoComplete="off" /></label>
      <label className="block space-y-2 text-sm">{t("oct19Voice.observationSha256_1fmlx27")}<Input aria-label={t("oct19Voice.detectorRemovalObservationSha256_8qdm2f")} value={observationDigest} onChange={event => { setObservationDigest(event.target.value); setDetectorConfirmed(false); }} autoComplete="off" /></label>
      <p className="text-xs text-muted-foreground">{t("oct19Voice.useTheDigestOfTheSecret_10q4589")}</p>
      <label className="block space-y-2 text-sm">{t("oct19Voice.observedAtUtc_12amebb")}<Input aria-label={t("oct19Voice.detectorRemovalObservedAtUtc_bi1eyn")} value={detectorObservedAt} onChange={event => { setDetectorObservedAt(event.target.value); setDetectorConfirmed(false); }} placeholder="YYYY-MM-DDTHH:mm:ss.sssZ" autoComplete="off" /></label>
      <p className="text-xs text-muted-foreground">{t("oct19Voice.enterTheActualRuntimeListingTime_f7v5t5")}</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={detectorConfirmed} onChange={event => setDetectorConfirmed(event.target.checked)} className="mt-1 accent-primary" /><span>{t("oct19Voice.iObservedThisExactHookAbsent_opll6g")}</span></label>
      <div className="flex items-center justify-between gap-3"><Button type="button" variant="ghost" onClick={() => setDetectorSnapshot(null)}>{t("oct19Voice.cancel_ew9em3")}</Button><Button type="button" disabled={!detectorConfirmed || !detectorObservedAtValid || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(detectorHookId) || !/^[a-f0-9]{64}$/.test(observationDigest) || busy || offline} onClick={() => onAttestDetectorCleanup?.({ ...detectorSnapshot, detectorRemoved: true, observation: { method: "hooks.list", includeDisabled: true, hookId: detectorHookId, outcome: "exact_hook_absent", observedAt: detectorObservedAt, sha256: observationDigest } })}>{t("oct19Voice.confirmDetectorObservation_lwkigt")}</Button></div>
    </section>}
    {attestation && <section aria-label={t("oct19Voice.attestThisMuseWorkerStopped_1y706hp")} className="space-y-3 rounded-md border border-border p-3">
      <p className="text-sm font-medium">{t("oct19Voice.confirmTheWorkerForThisExact_1u7xkc")}</p>
      <dl className="space-y-2 text-xs">
        {Object.entries(attestation.boundary).map(([key, value]) => <div key={key} className="flex flex-wrap items-baseline justify-between gap-2"><dt className="text-muted-foreground">{key}</dt><dd className="break-all font-mono">{value === null ? t("oct19Voice.none_deku7v") : String(value)}</dd></div>)}
      </dl>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 accent-primary" /><span>{t("oct19Voice.iHaveStoppedThisMuseWorker_1s8it1z")}</span></label>
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={() => setAttestation(null)}>{t("oct19Voice.cancel_ew9em3")}</Button>
        <Button type="button" disabled={!confirmed || busy} onClick={() => onAttest(attestation)}>{t("oct19Voice.confirmWorkerStopped_f7o6km")}</Button>
      </div>
    </section>}
    {pairing && !b?.paired && <div className="space-y-2">
      <AgentSetupPrompt key={pairing.bindingId + pairing.revision} prompt={pairing.setupInstruction} label={t("oct19Voice.copySetupPrompt_1qzokyx")} title={t("oct19Voice.connectYourMuse_1k18uqe")} agent={{ name: "Muse", icon: <Bot className="size-5" /> }} description={t("oct19Voice.pasteIntoYourCurrentMuseConversation_12kwm7d")} />
      <p className="text-xs text-muted-foreground">{t("oct19Voice.museSetupExpires", { time: formatDateTime(pairing.expiresAt) })}</p>
    </div>}
    <div className="flex flex-wrap items-center gap-2">
      {live && <Button type="button" variant="outline" disabled={!configure || b.credentialState !== "active" || !b.paired || busy || testing} onClick={onTest}>{testing ? t("oct19Voice.testingBackgroundReply_10avbwp") : t("oct19Voice.testBackgroundReply_1vy7683")}</Button>}
      <Button type="button" variant="outline" disabled={!configure || busy} onClick={onRepair}>{b?.credentialState === "expired" ? t("oct19Voice.reconnectMuse_1y26e98") : live ? t("oct19Voice.repairConnection_lhahn0") : t("oct19Voice.connectMuse_hvc445")}</Button>
      {connection.agentStatus !== "paused" && connection.agentStatus !== "terminated" && <Button type="button" variant="outline" disabled={busy} onClick={onPause}>{t("oct19Voice.pauseAgent_f9qed8")}</Button>}
      {live && <Button type="button" variant="outline" disabled={busy} onClick={onDisconnect}>{t("oct19Voice.disconnect_1ompkaz")}</Button>}
      <Button type="button" variant="ghost" disabled={busy} onClick={onRefresh}>{t("oct19Voice.refresh_28r6qc")}</Button>
      <Button type="button" asChild variant="ghost"><a href="https://muse.ai" target="_blank" rel="noopener noreferrer">{t("oct19Voice.openMuse_pbmdvp")}</a></Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}

export function MuseRunnerConnection({ companyId, agentId }: { companyId?: string; agentId?: string }) {
  useTranslation();
  const cache = useQueryClient();
  const muse = useMuseConnection(companyId, agentId);
  const pause = useMutation({ mutationFn: () => agentsApi.pause(agentId!, companyId), onSuccess: () => {
    void muse.refresh(); void cache.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId!) });
    if (companyId) void cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
  } });
  if (!agentId) return <p className="text-sm text-muted-foreground">{t("oct19Voice.saveTheAgentThenConnectYour_2s47po")}</p>;
  const error = muse.state.error ?? muse.pair.error ?? muse.verify.error ?? muse.revoke.error ?? muse.attest.error ?? muse.attestDetector.error ?? pause.error;
  if (muse.identity.failed) return <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{t("oct19Voice.unableToConfirmYourAccountRefresh_17u4quv")}</p><Button type="button" variant="outline" onClick={() => { void cache.invalidateQueries({ queryKey: queryKeys.auth.session }); }}>{t("oct19Voice.refresh_28r6qc")}</Button></div>;
  if (!muse.state.data) return <div className="space-y-3"><p role="status" className="text-sm text-muted-foreground">{muse.state.error ? t("oct19Voice.unableToLoadTheMuseConnection_sajzf2") : t("oct19Voice.loadingMuseConnection_1nk7h41")}</p>{error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}<Button type="button" variant="outline" onClick={() => { void muse.state.refetch(); }}>{t("oct19Voice.refresh_28r6qc")}</Button></div>;
  return <MuseConnectionDetails key={muse.identity.userId} connection={muse.state.data} pairing={muse.pairing} offline={muse.state.isError}
    busy={muse.pair.isPending || muse.verify.isPending || muse.revoke.isPending || muse.attest.isPending || muse.attestDetector.isPending || pause.isPending}
    error={error?.message} onTest={() => { if (muse.binding) muse.verify.mutate(muse.binding); }} onRepair={muse.repair}
    onPause={() => pause.mutate()} onDisconnect={() => { if (muse.binding) muse.revoke.mutate(muse.binding); }}
    onRefresh={() => { void muse.state.refetch(); }} onAttest={input => muse.attest.mutate(input)} onAttestDetectorCleanup={input => muse.attestDetector.mutate(input)} />;
}
