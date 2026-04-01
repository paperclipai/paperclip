import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  useAgentConfigHelp,
} from "../../components/agent-config-primitives";
import { useI18n } from "../../i18n";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function HttpConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const { t } = useI18n();
  const help = useAgentConfigHelp();
  return (
    <Field label={t("agentConfig.fields.webhookUrlLabel")} hint={help.webhookUrl}>
      <DraftInput
        value={
          isCreate
            ? values!.url
            : eff("adapterConfig", "url", String(config.url ?? ""))
        }
        onCommit={(v) =>
          isCreate
            ? set!({ url: v })
            : mark("adapterConfig", "url", v || undefined)
        }
        immediate
        className={inputClass}
        placeholder="https://..."
      />
    </Field>
  );
}
