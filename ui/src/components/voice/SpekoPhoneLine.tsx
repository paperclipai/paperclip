import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { VoicePhoneConfiguration } from "@paperclipai/shared";
import { voicePhoneApi } from "@/api/voicePhone";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useTranslation } from "@/i18n";
export interface SpekoPhoneLineFormProps { configuration?: VoicePhoneConfiguration; loading?: boolean; saving?: boolean; saved?: boolean; error?: string; onRefresh(): void; onSave(input: {numberId: string; enabled: boolean; guestIntake?: boolean; lowTrustEnvironmentId?: string | null}): void }
export function SpekoPhoneLineForm({configuration, loading, saving, saved, error, onRefresh, onSave}: SpekoPhoneLineFormProps) {
  const [numberId, setNumberId] = useState(configuration?.number?.id ?? ""), [enabled, setEnabled] = useState(configuration?.number?.enabled ?? false), [guestIntake, setGuestIntake] = useState(configuration?.number?.guestIntake ?? false), [invalid, setInvalid] = useState(false), [environmentId, setEnvironmentId] = useState(configuration?.number?.lowTrustEnvironmentId ?? "");
  useEffect(() => {setNumberId(configuration?.number?.id ?? ""); setEnabled(configuration?.number?.enabled ?? false); setGuestIntake(configuration?.number?.guestIntake ?? false); setEnvironmentId(configuration?.number?.lowTrustEnvironmentId ?? "");}, [configuration]);
  const { t } = useTranslation();
  const selected = configuration?.inventory.find(n => n.id === numberId);
  return <section className="max-w-xl space-y-3">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t("agents.SpekoPhoneLineForm.heading")}</h2><Button size="sm" variant="ghost" disabled={loading || saving} onClick={onRefresh}>{t("agents.SpekoPhoneLineForm.refreshNumbers")}</Button></div>
    <p className="text-sm text-muted-foreground">{t("agents.SpekoPhoneLineForm.intro")}</p>
    {loading && <p role="status" className="text-sm text-muted-foreground">{t("agents.SpekoPhoneLineForm.loadingNumbers")}</p>}
    {!loading && !configuration?.inventory.length && <p className="text-sm text-muted-foreground">{t("agents.SpekoPhoneLineForm.noNumbers")} <a className="text-primary underline" href="https://platform.speko.ai" target="_blank" rel="noreferrer">{t("agents.SpekoPhoneLineForm.buyNumber")}</a>{t("agents.SpekoPhoneLineForm.afterLink")}</p>}
    <form className="space-y-3" onSubmit={event => {event.preventDefault(); if (!numberId || !selected?.available) {setInvalid(true); return;} setInvalid(false); onSave({numberId, enabled, guestIntake, lowTrustEnvironmentId: environmentId || null});}}>
      <label className="grid min-w-0 gap-2 text-sm font-medium">{t("agents.SpekoPhoneLineForm.numberLabel")}<select aria-label={t("agents.SpekoPhoneLineForm.numberLabel")} disabled={loading || saving} className="min-w-0 w-full rounded-md border border-input bg-background p-2 text-sm" value={numberId} onChange={event => {setNumberId(event.target.value); setInvalid(false);}}><option value="">{t("agents.SpekoPhoneLineForm.selectNumber")}</option>{configuration?.inventory.map(n => <option key={n.id} value={n.id} disabled={!n.available}>{n.phoneNumber}{n.label ? ` · ${n.label}` : ""}{!n.available ? t("agents.SpekoPhoneLineForm.unavailableSuffix") : ""}</option>)}</select></label>
      {selected && !selected.inboundReady && <p className="text-sm text-muted-foreground">{t("agents.SpekoPhoneLineForm.completeSetup")}{selected.issues.length ? ` ${selected.issues.join(". ")}` : ""}</p>}
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={enabled} disabled={loading || saving} onCheckedChange={value => setEnabled(value === true)} />{t("agents.SpekoPhoneLineForm.enableNumber")}</label>
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={guestIntake} disabled={loading || saving} onCheckedChange={value => setGuestIntake(value === true)} />{t("agents.SpekoPhoneLineForm.guestIntake")}</label>
      {guestIntake && <p className="text-sm text-muted-foreground">{t("agents.SpekoPhoneLineForm.guestIntakeNotice")}</p>}
      {guestIntake && <label className="grid min-w-0 gap-2 text-sm font-medium">{t("agents.SpekoPhoneLineForm.sandboxLabel")}<select aria-label={t("agents.SpekoPhoneLineForm.sandboxLabel")} disabled={loading || saving} className="min-w-0 w-full rounded-md border border-input bg-background p-2 text-sm" value={environmentId} onChange={event => setEnvironmentId(event.target.value)}><option value="">{t("agents.SpekoPhoneLineForm.useAgentSandbox")}</option>{configuration?.sandboxEnvironments?.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select><span className="text-sm font-normal text-muted-foreground">{t("agents.SpekoPhoneLineForm.sandboxNotice")}</span></label>}
      {invalid && <p role="alert" className="text-sm text-destructive">{t("agents.SpekoPhoneLineForm.chooseNumber")}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center justify-between gap-3"><p role="status" className="text-sm text-muted-foreground">{saved ? t("agents.SpekoPhoneLineForm.saved") : ""}</p><Button type="submit" disabled={loading || saving}>{saving ? t("agents.SpekoPhoneLineForm.saving") : t("agents.SpekoPhoneLineForm.save")}</Button></div>
    </form>
  </section>;
}
export function SpekoPhoneLine({companyId, endpointId}: {companyId: string; endpointId: string}) {
  const queryClient = useQueryClient(), key = ["speko-phone-line", companyId, endpointId];
  const query = useQuery({queryKey: key, queryFn: () => voicePhoneApi.configuration(companyId, endpointId)});
  const mutation = useMutation({mutationFn: (input: {numberId: string; enabled: boolean; guestIntake?: boolean; lowTrustEnvironmentId?: string | null}) => voicePhoneApi.save(companyId, endpointId, input), onSuccess: data => queryClient.setQueryData(key, data)});
  return <SpekoPhoneLineForm configuration={query.data} loading={query.isLoading} saving={mutation.isPending} saved={mutation.isSuccess} error={(mutation.error ?? query.error)?.message} onRefresh={() => void query.refetch()} onSave={input => mutation.mutate(input)} />;
}
