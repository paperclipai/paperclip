import type { AdapterConfigFieldsProps } from "./types";
import { Field, help } from "../components/agent-config-primitives";

const selectClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono";

export function BillingModeField({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: Pick<AdapterConfigFieldsProps, "isCreate" | "values" | "set" | "config" | "eff" | "mark">) {
  const value = isCreate
    ? String(values?.billingMode ?? "auto")
    : eff("adapterConfig", "billingMode", String(config.billingMode ?? "auto"));

  return (
    <Field label="Billing mode" hint={help.billingMode}>
      <select
        value={value}
        onChange={(e) =>
          isCreate
            ? set?.({ billingMode: e.target.value })
            : mark("adapterConfig", "billingMode", e.target.value === "auto" ? undefined : e.target.value)
        }
        className={selectClass}
      >
        <option value="auto">Auto (detect from API keys)</option>
        <option value="subscription">Subscription (non-billable)</option>
        <option value="metered">Metered API (billable)</option>
      </select>
    </Field>
  );
}
