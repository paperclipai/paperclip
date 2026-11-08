import { useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { VoicePhoneConfiguration } from "@paperclipai/shared";
import { voicePhoneApi } from "@/api/voicePhone";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
export interface SpekoPhoneLineFormProps { configuration?: VoicePhoneConfiguration; loading?: boolean; saving?: boolean; saved?: boolean; error?: string; onRefresh(): void; onSave(input: {numberId: string; enabled: boolean; guestIntake?: boolean; lowTrustEnvironmentId?: string | null}): void }
export function SpekoPhoneLineForm({configuration, loading, saving, saved, error, onRefresh, onSave}: SpekoPhoneLineFormProps) {
  const { t } = useTranslation("connections");
  const [numberId, setNumberId] = useState(configuration?.number?.id ?? ""), [enabled, setEnabled] = useState(configuration?.number?.enabled ?? false), [guestIntake, setGuestIntake] = useState(configuration?.number?.guestIntake ?? false), [invalid, setInvalid] = useState(false), [environmentId, setEnvironmentId] = useState(configuration?.number?.lowTrustEnvironmentId ?? "");
  useEffect(() => {setNumberId(configuration?.number?.id ?? ""); setEnabled(configuration?.number?.enabled ?? false); setGuestIntake(configuration?.number?.guestIntake ?? false); setEnvironmentId(configuration?.number?.lowTrustEnvironmentId ?? "");}, [configuration]);
  const selected = configuration?.inventory.find(n => n.id === numberId);
  return <section className="max-w-xl space-y-3">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t("incoming_calls_63f0c27")}</h2><Button size="sm" variant="ghost" disabled={loading || saving} onClick={onRefresh}>{t("refresh_numbers_b6d4aa9")}</Button></div>
    <p className="text-sm text-muted-foreground">{t("let_callers_start_a_conversation_in_a_0cf948d")}</p>
    {loading && <p role="status" className="text-sm text-muted-foreground">{t("loading_speko_numbers_3afaa82")}</p>}
    {!loading && !configuration?.inventory.length && <p className="text-sm text-muted-foreground">{t("no_numbers_are_available_321dcf1")}<a className="text-primary underline" href="https://platform.speko.ai" target="_blank" rel="noreferrer">{t("buy_or_import_a_number_in_speko_8a8b0ee")}</a>{t("complete_verification_and_add_credits_then_refresh_2ffc887")}</p>}
    <form className="space-y-3" onSubmit={event => {event.preventDefault(); if (!numberId || !selected?.available) {setInvalid(true); return;} setInvalid(false); onSave({numberId, enabled, guestIntake, lowTrustEnvironmentId: environmentId || null});}}>
      <label className="grid min-w-0 gap-2 text-sm font-medium">{t("company_phone_number_55e1980")}<select aria-label={t("company_phone_number_55e1980")} disabled={loading || saving} className="min-w-0 w-full rounded-md border border-input bg-background p-2 text-sm" value={numberId} onChange={event => {setNumberId(event.target.value); setInvalid(false);}}><option value="">{t("select_a_number_d6b0668")}</option>{configuration?.inventory.map(n => <option key={n.id} value={n.id} disabled={!n.available}>{n.phoneNumber}{n.label ? ` · ${n.label}` : ""}{!n.available ? t("unavailable_80bcb8f") : ""}</option>)}</select></label>
      {selected && !selected.inboundReady && <p className="text-sm text-muted-foreground">{t("complete_number_setup_in_speko_before_enabling_8f2dbb3", { value: selected.issues.length ? ` ${selected.issues.join(". ")}` : "" })}</p>}
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={enabled} disabled={loading || saving} onCheckedChange={value => setEnabled(value === true)} />{t("enable_incoming_calls_on_this_number_272e5d2")}</label>
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={guestIntake} disabled={loading || saving} onCheckedChange={value => setGuestIntake(value === true)} />{t("let_callers_start_new_low_trust_tasks_c2118ab")}</label>
      {guestIntake && <p className="text-sm text-muted-foreground">{t("each_call_gets_its_own_task_the_6e89865")}</p>}
      {guestIntake && <label className="grid min-w-0 gap-2 text-sm font-medium">{t("execution_sandbox_d1955dd")}<select aria-label={t("execution_sandbox_d1955dd")} disabled={loading || saving} className="min-w-0 w-full rounded-md border border-input bg-background p-2 text-sm" value={environmentId} onChange={event => setEnvironmentId(event.target.value)}><option value="">{t("use_this_agent_s_sandbox_eb5098c")}</option>{configuration?.sandboxEnvironments?.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select><span className="text-sm font-normal text-muted-foreground">{t("only_new_incoming_tasks_use_this_setting_bdcb25f")}</span></label>}
      {invalid && <p role="alert" className="text-sm text-destructive">{t("choose_an_available_company_phone_number_2965a65")}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center justify-between gap-3"><p role="status" className="text-sm text-muted-foreground">{saved ? t("incoming_call_setting_saved_14b7891") : ""}</p><Button type="submit" disabled={loading || saving}>{saving ? t("saving_56a2285") : t("save_incoming_call_setting_5f2c91c")}</Button></div>
    </form>
  </section>;
}
export function SpekoPhoneLine({companyId, endpointId}: {companyId: string; endpointId: string}) {
  const queryClient = useQueryClient(), key = ["speko-phone-line", companyId, endpointId];
  const query = useQuery({queryKey: key, queryFn: () => voicePhoneApi.configuration(companyId, endpointId)});
  const mutation = useMutation({mutationFn: (input: {numberId: string; enabled: boolean; guestIntake?: boolean; lowTrustEnvironmentId?: string | null}) => voicePhoneApi.save(companyId, endpointId, input), onSuccess: data => queryClient.setQueryData(key, data)});
  return <SpekoPhoneLineForm configuration={query.data} loading={query.isLoading} saving={mutation.isPending} saved={mutation.isSuccess} error={(mutation.error ?? query.error)?.message} onRefresh={() => void query.refetch()} onSave={input => mutation.mutate(input)} />;
}
