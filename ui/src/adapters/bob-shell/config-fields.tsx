import React from "react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  DraftNumberInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function getSchemaValue(values: any, key: string, defaultValue: any = ""): any {
  return values?.adapterSchemaValues?.[key] ?? defaultValue;
}

function getConfigValue(config: any, key: string, defaultValue: any = ""): any {
  return config?.[key] ?? defaultValue;
}

export function BobShellConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const setSchemaValue = (key: string, value: any) => {
    if (isCreate) {
      set!({
        adapterSchemaValues: {
          ...(values?.adapterSchemaValues ?? {}),
          [key]: value,
        },
      });
    } else {
      mark("adapterConfig", key, value);
    }
  };

  return (
    <div className="space-y-4">
      <Field label="Command" hint="Optional, defaults to 'bob'">
        <DraftInput
          className={inputClass}
          value={
            isCreate
              ? getSchemaValue(values, "command", "")
              : eff("adapterConfig", "command", getConfigValue(config, "command", ""))
          }
          onCommit={(v) => setSchemaValue("command", v || undefined)}
          immediate
          placeholder="bob"
        />
      </Field>

      <Field label="Mode" hint="Optional, defaults to 'paperclip-agent'">
        <DraftInput
          className={inputClass}
          value={
            isCreate
              ? getSchemaValue(values, "mode", "")
              : eff("adapterConfig", "mode", getConfigValue(config, "mode", ""))
          }
          onCommit={(v) => setSchemaValue("mode", v || undefined)}
          immediate
          placeholder="paperclip-agent"
        />
      </Field>

      <Field label="When to Use" hint="When to use this mode">
        <DraftInput
          className={inputClass}
          value={
            isCreate
              ? getSchemaValue(values, "modeConfig.whenToUse", "")
              : eff("adapterConfig", "modeConfig.whenToUse", getConfigValue(config?.modeConfig, "whenToUse", ""))
          }
          onCommit={(v) => {
            const modeConfig = isCreate 
              ? (values?.adapterSchemaValues?.modeConfig ?? {})
              : (config?.modeConfig ?? {});
            setSchemaValue("modeConfig", { ...modeConfig, whenToUse: v || undefined });
          }}
          immediate
          placeholder="Use for Paperclip-managed coding work"
        />
      </Field>


      <Field label="Tool Groups" hint="Comma-separated: read, edit, command, browser, mcp">
        <DraftInput
          className={inputClass}
          value={
            isCreate
              ? (() => {
                  const groups = getSchemaValue(values, "modeConfig.groups", "");
                  return Array.isArray(groups) ? groups.join(", ") : String(groups);
                })()
              : eff(
                  "adapterConfig",
                  "modeConfig.groups",
                  (() => {
                    const groups = getConfigValue(config?.modeConfig, "groups", "");
                    return Array.isArray(groups) ? groups.join(", ") : String(groups);
                  })()
                )
          }
          onCommit={(v) => {
            const groups = v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            const modeConfig = isCreate 
              ? (values?.adapterSchemaValues?.modeConfig ?? {})
              : (config?.modeConfig ?? {});
            setSchemaValue("modeConfig", { ...modeConfig, groups: groups.length > 0 ? groups : undefined });
          }}
          immediate
          placeholder="read, edit, command, browser, mcp"
        />
      </Field>

      <Field label="Working Directory" hint="Optional, absolute path">
        <DraftInput
          className={inputClass}
          value={
            isCreate
              ? values!.cwd ?? ""
              : eff("adapterConfig", "cwd", String(config.cwd ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ cwd: v })
              : mark("adapterConfig", "cwd", v || undefined)
          }
          immediate
          placeholder="/path/to/workspace"
        />
      </Field>



      <Field label="Timeout (seconds)" hint="0 for no timeout">
        <DraftNumberInput
          className={inputClass}
          value={
            isCreate
              ? getSchemaValue(values, "timeoutSec", 0)
              : eff("adapterConfig", "timeoutSec", Number(getConfigValue(config, "timeoutSec", 0)))
          }
          onCommit={(v) => setSchemaValue("timeoutSec", v)}
          immediate
          placeholder="0"
          min={0}
        />
      </Field>

      <Field label="Grace Period (seconds)" hint="SIGTERM grace before SIGKILL">
        <DraftNumberInput
          className={inputClass}
          value={
            isCreate
              ? getSchemaValue(values, "graceSec", 20)
              : eff("adapterConfig", "graceSec", Number(getConfigValue(config, "graceSec", 20)))
          }
          onCommit={(v) => setSchemaValue("graceSec", v)}
          immediate
          placeholder="20"
          min={0}
        />
      </Field>

      <Field label="Extra Arguments" hint="Comma-separated">
        <DraftInput
          className={inputClass}
          value={
            isCreate
              ? (() => {
                  const args = getSchemaValue(values, "extraArgs", "");
                  return Array.isArray(args) ? args.join(", ") : String(args);
                })()
              : eff(
                  "adapterConfig",
                  "extraArgs",
                  (() => {
                    const args = getConfigValue(config, "extraArgs", "");
                    return Array.isArray(args) ? args.join(", ") : String(args);
                  })()
                )
          }
          onCommit={(v) => {
            const args = v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            setSchemaValue("extraArgs", args.length > 0 ? args : undefined);
          }}
          immediate
          placeholder="--verbose, --debug"
        />
      </Field>

      <div className="pt-4 border-t text-sm text-muted-foreground">
        <strong>Note:</strong> Bob Shell must be installed and available in PATH.
        Paperclip will generate <code className="px-1 py-0.5 bg-muted rounded">.bob/</code> workspace configuration before
        launching Bob Shell.
      </div>
    </div>
  );
}
