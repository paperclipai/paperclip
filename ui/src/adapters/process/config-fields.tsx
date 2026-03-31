import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  useAgentConfigHelp,
} from "../../components/agent-config-primitives";
import { useI18n } from "../../i18n";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function formatArgList(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .join(", ");
  }
  return typeof value === "string" ? value : "";
}

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function ProcessConfigFields({
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
    <>
      <Field label={t("agentConfig.fields.command")} hint={help.command}>
        <DraftInput
          value={
            isCreate
              ? values!.command
              : eff("adapterConfig", "command", String(config.command ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ command: v })
              : mark("adapterConfig", "command", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder={t("agentConfig.fields.commandPlaceholder")}
        />
      </Field>
      <Field label={t("agentConfig.fields.argsCommaSeparated")} hint={help.args}>
        <DraftInput
          value={
            isCreate
              ? values!.args
              : eff("adapterConfig", "args", formatArgList(config.args))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ args: v })
              : mark(
                  "adapterConfig",
                  "args",
                  v ? parseCommaArgs(v) : undefined,
                )
          }
          immediate
          className={inputClass}
          placeholder={t("agentConfig.fields.argsPlaceholder")}
        />
      </Field>
    </>
  );
}
