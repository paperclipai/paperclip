import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MuseConnection, MusePairing, MuseAttestStopInput } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { useMuseConnection, museConnectionState } from "@/hooks/useMuseConnection";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";
import { AgentSetupPrompt } from "./AgentSetupPrompt";
import { MuseConnectionChecks } from "./new-agent/ExternalAgentInviteContent";
import { Button } from "./ui/button";

export interface MuseConnectionDetailsProps {
  connection: MuseConnection;
  pairing?: MusePairing | null;
  busy?: boolean;
  error?: string;
  onTest: () => void;
  onRepair: () => void;
  onPause: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
  onAttest: (input: MuseAttestStopInput) => void;
}

/** The settings view uses the same connection evidence as the invitation. */
export function MuseConnectionDetails({ connection, pairing, busy, error, onTest, onRepair, onPause, onDisconnect, onRefresh, onAttest }: MuseConnectionDetailsProps) {
  const b = connection.binding;
  const [attestation, setAttestation] = useState<MuseAttestStopInput | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const boundaryIdentity = JSON.stringify(b?.stop.boundary);
  const stopBindingRevision = b?.stop.bindingRevision;
  useEffect(() => { setAttestation(null); setConfirmed(false); }, [boundaryIdentity, stopBindingRevision]);
  const live = !!b && b.status !== "revoked";
  const testing = !!b?.challengeExpiresAt && Date.parse(b.challengeExpiresAt) > Date.now() && !b.backgroundReplyVerified;
  const configure = connection.enabled && connection.canConfigureConnection && !!connection.publicOrigin;
  const timestamp = (value: string | null) => value ? formatDateTime(value, { includeSeconds: true }) : "Not observed";
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">Muse uses its own tools and permissions. Paperclip coordinates company tasks and questions. Provider usage and cost are unavailable.</p>
    {!connection.enabled && <p className="text-sm text-muted-foreground">Muse is disabled in experimental settings. Connection cleanup and stop evidence remain available.</p>}
    {!connection.publicOrigin && <p className="text-sm text-muted-foreground">An authenticated instance with a public HTTPS URL is required to connect Muse.</p>}
    {b && <>
      <MuseConnectionChecks state={museConnectionState(connection)} />
      <dl className="space-y-2 text-xs">
        {[
          ["Last persisted receiver contact", timestamp(b.lastReceiverContactAt)],
          ["Authenticated worker activity", timestamp(b.lastWorkerActivityAt)],
          ["Last verified reply", timestamp(b.lastVerifiedReplyAt)],
          ["Client version", b.clientVersion ?? "Not reported"],
          ["Live assignments", String(b.liveAssignments)],
          ["Uncertain native operations", String(b.uncertainOperations)],
          ["Pending answers", String(b.pendingInputs)],
          ["Usage and cost", "Unavailable"],
        ].map(([label, value]) => <div key={label} className="flex flex-wrap items-baseline justify-between gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="font-mono">{value}</dd></div>)}
      </dl>
      <p className="text-xs text-muted-foreground">Receiver contact is persisted in batches and may lag by up to {Math.ceil(b.contactPersistenceLagMs / 1000)} seconds. Receiver checks do not prove worker readiness.</p>
      {b.status === "revoked" && <p role="status" className="text-sm text-muted-foreground">Disconnected. Paperclip credentials and execution authority were revoked.</p>}
      {(b.cleanup.pending || b.status === "revoked") && <div className="space-y-2 text-sm text-muted-foreground">
        {"detectorRemovalRequested" in b.cleanup && b.cleanup.detectorRemovalRequested === true && !b.cleanup.detectorRemoved && <p>Detector removal requested; completion is not confirmed.</p>}
        <p>Detector removal: {b.cleanup.detectorRemoved ? "acknowledged" : "not confirmed"}. Worker quiescence: {b.cleanup.workerQuiescenceReported ? "reported" : "not confirmed"}.</p>
        {b.cleanup.expiresAt && <p className="text-xs">Cleanup capability expires {formatDateTime(b.cleanup.expiresAt)}.</p>}
        <p>Detector removal, worker stopping, and sandbox cleanup are separate. Paperclip cannot verify every private Muse tool or stop all personal Muse conversations.</p>
      </div>}
      {b.stop.status !== "none" && <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{b.stop.status === "operator_attested" ? "You attested that this assignment’s Muse worker stopped."
          : b.stop.status === "worker_reported" ? "Muse reported that this assignment’s worker is quiescent. Independent private effects remain unconfirmed."
          : "Paperclip fenced this assignment’s authority. Its external stop cannot be confirmed."}</p>
        {b.stop.nativeEffectsUnknown && <p role="status" className="text-muted-foreground">Native effect outcomes remain unknown and block replacement work. Worker attestation does not resolve or replay those effects.</p>}
        {b.stop.boundary && stopBindingRevision == null && b.stop.status !== "operator_attested" && <p role="status" className="text-muted-foreground">Stop binding revision is unavailable. Refresh to inspect this assignment before attesting.</p>}
        {b.stop.boundary && b.stop.status !== "operator_attested" && !attestation && <Button type="button" variant="outline" disabled={busy || stopBindingRevision == null} onClick={() => {
          if (!b.stop.boundary || stopBindingRevision == null) return;
          setAttestation({ boundary: { ...b.stop.boundary }, expectedRevision: stopBindingRevision, workerStopped: true }); setConfirmed(false);
        }}>Attest this worker stopped</Button>}
      </div>}
    </>}
    {attestation && <section aria-label="Attest this Muse worker stopped" className="space-y-3 rounded-md border border-border p-3">
      <p className="text-sm font-medium">Confirm the worker for this exact assignment stopped</p>
      <dl className="space-y-2 text-xs">
        {Object.entries(attestation.boundary).map(([key, value]) => <div key={key} className="flex flex-wrap items-baseline justify-between gap-2"><dt className="text-muted-foreground">{key}</dt><dd className="break-all font-mono">{value === null ? "None" : String(value)}</dd></div>)}
      </dl>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 accent-primary" /><span>I have stopped this Muse worker for the named assignment and run. This does not certify independent private tools or unknown native effects.</span></label>
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={() => setAttestation(null)}>Cancel</Button>
        <Button type="button" disabled={!confirmed || busy} onClick={() => onAttest(attestation)}>Confirm worker stopped</Button>
      </div>
    </section>}
    {pairing && !b?.paired && <div className="space-y-2">
      <AgentSetupPrompt key={pairing.bindingId + pairing.revision} prompt={pairing.setupInstruction} label="Copy setup prompt" title="Connect your Muse" agent={{ name: "Muse", icon: <Bot className="size-5" /> }} description="Paste into your current Muse conversation. Approve the Paperclip hostname in Muse’s permission UI." />
      <p className="text-xs text-muted-foreground">One-use setup expires {formatDateTime(pairing.expiresAt)}. Hostname permission applies to future requests to this Paperclip hostname.</p>
    </div>}
    <div className="flex flex-wrap items-center gap-2">
      {live && <Button type="button" variant="outline" disabled={!configure || !b.paired || busy || testing} onClick={onTest}>{testing ? "Testing background reply…" : "Test background reply"}</Button>}
      <Button type="button" variant="outline" disabled={!configure || busy} onClick={onRepair}>{live ? "Repair connection" : "Connect Muse"}</Button>
      {connection.agentStatus !== "paused" && connection.agentStatus !== "terminated" && <Button type="button" variant="outline" disabled={busy} onClick={onPause}>Pause agent</Button>}
      {live && <Button type="button" variant="outline" disabled={busy} onClick={onDisconnect}>Disconnect</Button>}
      <Button type="button" variant="ghost" disabled={busy} onClick={onRefresh}>Refresh</Button>
      <Button type="button" asChild variant="ghost"><a href="https://muse.ai" target="_blank" rel="noopener noreferrer">Open Muse</a></Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}

export function MuseRunnerConnection({ companyId, agentId }: { companyId?: string; agentId?: string }) {
  const cache = useQueryClient();
  const muse = useMuseConnection(companyId, agentId);
  const pause = useMutation({ mutationFn: () => agentsApi.pause(agentId!, companyId), onSuccess: () => {
    void muse.refresh(); void cache.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId!) });
    if (companyId) void cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
  } });
  if (!agentId) return <p className="text-sm text-muted-foreground">Save the agent, then connect your personal Muse here.</p>;
  const error = muse.state.error ?? muse.pair.error ?? muse.verify.error ?? muse.revoke.error ?? muse.attest.error ?? pause.error;
  if (muse.identity.failed) return <div className="space-y-3"><p role="alert" className="text-sm text-destructive">Unable to confirm your account. Refresh to inspect this Muse connection.</p><Button type="button" variant="outline" onClick={() => { void cache.invalidateQueries({ queryKey: queryKeys.auth.session }); }}>Refresh</Button></div>;
  if (!muse.state.data) return <div className="space-y-3"><p role="status" className="text-sm text-muted-foreground">{muse.state.error ? "Unable to load the Muse connection." : "Loading Muse connection…"}</p>{error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}<Button type="button" variant="outline" onClick={() => { void muse.state.refetch(); }}>Refresh</Button></div>;
  return <MuseConnectionDetails connection={muse.state.data} pairing={muse.pairing}
    busy={muse.pair.isPending || muse.verify.isPending || muse.revoke.isPending || muse.attest.isPending || pause.isPending}
    error={error?.message} onTest={() => { if (muse.binding) muse.verify.mutate(muse.binding); }} onRepair={muse.repair}
    onPause={() => pause.mutate()} onDisconnect={() => { if (muse.binding) muse.revoke.mutate(muse.binding); }}
    onRefresh={() => { void muse.state.refetch(); }} onAttest={input => muse.attest.mutate(input)} />;
}
