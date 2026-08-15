import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function DeflectorConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="KB path" hint="Optional absolute path to kb.sqlite">
        <DraftInput
          value={
            isCreate
              ? String((values as Record<string, unknown> | null)?.kbPath ?? "")
              : String(eff("adapterConfig", "kbPath", config.kbPath ?? "") ?? "")
          }
          onCommit={(v) => {
            if (isCreate && set) set({ ...(values ?? {}), kbPath: v } as never);
            else mark("adapterConfig", "kbPath", v);
          }}
          className={inputClass}
          placeholder="~/.paperclip/instances/default/deflector/kb.sqlite"
        />
      </Field>
      <Field label="Audit path" hint="Optional absolute path to audit JSONL">
        <DraftInput
          value={
            isCreate
              ? String((values as Record<string, unknown> | null)?.auditPath ?? "")
              : String(eff("adapterConfig", "auditPath", config.auditPath ?? "") ?? "")
          }
          onCommit={(v) => {
            if (isCreate && set) set({ ...(values ?? {}), auditPath: v } as never);
            else mark("adapterConfig", "auditPath", v);
          }}
          className={inputClass}
          placeholder="~/.paperclip/instances/default/deflector/audit.jsonl"
        />
      </Field>
    </>
  );
}
