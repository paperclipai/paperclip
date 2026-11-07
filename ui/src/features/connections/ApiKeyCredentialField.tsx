import { useTranslation, t as translate } from "@/i18n";
import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Providers supply only credentials the current user is authorized to use.
 * Values are opaque connection references, never secret values. */
export function ApiKeyCredentialField({ options, connectionId, onConnectionChange, value, onChange,
  disabled, loading, error, providerName, keysUrl, label = translate("connections:api_key_cf678ca") }: {
  options: { id: string; label: string; disabled?: boolean }[];
  connectionId: string | null;
  onConnectionChange(id: string): void;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  providerName: string;
  keysUrl: string;
  label?: string;
}) {
  const { t } = useTranslation("connections");
  const id = useId();
  const choices = connectionId && !options.some(option => option.id === connectionId)
    ? [{ id: connectionId, label: loading ? t("checking_saved_api_key_87f5d62") : t("previously_selected_key_unavailable_b7af458"), disabled: true }, ...options] : options;
  return <div className="space-y-2">
    <Label htmlFor={id}>{label}</Label>
    {choices.length > 0 && <select id={id} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      value={connectionId ?? ""} disabled={disabled} onChange={event => onConnectionChange(event.target.value)}>
      {choices.map(option => <option key={option.id} value={option.id} disabled={option.disabled}>{option.label}</option>)}
      <option value="">{t("enter_a_new_api_key_a3e4ec7")}</option>
    </select>}
    {!connectionId && <Input id={choices.length ? `${id}-new` : id} aria-label={choices.length ? t("new_api_key_bbc6538") : undefined}
      type="password" autoComplete="off" value={value} disabled={disabled}
      onChange={event => { onConnectionChange(""); onChange(event.target.value); }} placeholder={t("paste_your_api_key_e97ad53", { providerName: providerName })} />}
    {loading && <p role="status" className="text-sm text-muted-foreground">{t("checking_saved_api_keys_8e681db")}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{t("could_not_load_saved_api_keys_c6ff0dc", { error: error })}</p>}
    <a href={keysUrl} target="_blank" rel="noreferrer" className="text-sm underline">{t("get_an_api_key_92e4081", { providerName: providerName })}</a>
  </div>;
}
