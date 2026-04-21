import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function BastionclawConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="BastionClaw root" hint="Absolute path to the BastionClaw installation directory.">
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "bastionclaw_root", String(config.bastionclaw_root ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "bastionclaw_root", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="/Users/you/bastionclaw"
        />
      </Field>

      {!isCreate && (
        <>
          <Field label="Target JID" hint="Chat JID for task routing. Leave empty to use the main group.">
            <DraftInput
              value={eff("adapterConfig", "target_jid", String(config.target_jid ?? ""))}
              onCommit={(v) => mark("adapterConfig", "target_jid", v || undefined)}
              immediate
              className={inputClass}
              placeholder="(main group)"
            />
          </Field>

          <Field label="Timeout (seconds)" hint="Max seconds to wait for task completion.">
            <DraftInput
              value={eff("adapterConfig", "timeout_sec", String(config.timeout_sec ?? "1800"))}
              onCommit={(v) => {
                const parsed = Number.parseInt(v.trim(), 10);
                mark(
                  "adapterConfig",
                  "timeout_sec",
                  Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
                );
              }}
              immediate
              className={inputClass}
              placeholder="1800"
            />
          </Field>

          <Field label="Poll interval (seconds)" hint="How often to check SQLite for task completion.">
            <DraftInput
              value={eff("adapterConfig", "poll_interval_sec", String(config.poll_interval_sec ?? "5"))}
              onCommit={(v) => {
                const parsed = Number.parseInt(v.trim(), 10);
                mark(
                  "adapterConfig",
                  "poll_interval_sec",
                  Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
                );
              }}
              immediate
              className={inputClass}
              placeholder="5"
            />
          </Field>
        </>
      )}
    </>
  );
}
