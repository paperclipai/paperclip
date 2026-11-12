import { useMemo, useState, type ReactNode } from "react";
import { harnessPoolRuntimeConfigKeys, type HarnessPoolMemberV2 } from "@paperclipai/shared";
import { HarnessConfigPanels } from "../HarnessConfigPanels";
import { AgentRuntimeConfigSections } from "../AgentRuntimeConfigSections";
import { Button } from "../ui/button";
import { Field } from "../agent-config-primitives";
import { SelectPopover } from "../ui/select";

type Settings = NonNullable<HarnessPoolMemberV2["adapterConfig"]>;
const adapters = { claude_code: "claude_local", codex: "codex_local", grok: "grok_local", opencode: "opencode_local" } as const;
export function HarnessPoolRuntimeFields({ member, companyId, onChange, harnessFields, accountFields }: {
  member: Omit<HarnessPoolMemberV2, "connection">;
  companyId?: string;
  harnessFields?: ReactNode;
  accountFields?: ReactNode;
  onChange: (patch: Partial<HarnessPoolMemberV2>) => void;
}) {
  const settings = member.adapterConfig ?? {};
  const [confirmCli, setConfirmCli] = useState(false);
  const native = member.runner !== "legacy";
  const allowedConfigKeys = useMemo(() => new Set(harnessPoolRuntimeConfigKeys(member.harness.type, member.runner)), [member.harness.type, member.runner]);
  const provider = member.harness.type === "codex" ? "codex" : member.harness.type === "opencode" ? "opencode" : "acpx";
  const config: Record<string, unknown> = { ...settings, model: member.model, provider, ...(provider === "acpx" ? { acpxAgent: member.harness.type === "claude_code" ? "claude" : "grok" } : {}) };
  function changeEngine(engine: unknown) {
    const { mode: _mode, nonInteractivePermissions: _permissions, warmHandleIdleMs: _idle, permissionMode: _policy, ...common } = settings;
    onChange({ adapterConfig: engine === "cli" ? { ...common, engine } : { ...settings, engine: engine as Settings["engine"] } });
    setConfirmCli(false);
  }
  return <HarnessConfigPanels identity={<>
    {harnessFields}
    <Field label="Runner" hint="Changing runner resets its execution settings. The model and account stay selected."><SelectPopover aria-label="Runner" value={member.runner ?? "paperclip"}
      onValueChange={value => onChange({ runner: value === "legacy" ? "legacy" : "paperclip", adapterConfig: undefined })}
      options={[{ value: "legacy", label: "Legacy" }, { value: "paperclip", label: "Paperclip Runner" }]} /></Field>
    {accountFields}
  </>} runtime={<>
    {confirmCli && <div className="space-y-2 text-sm"><p>Switch to CLI and remove ACP session and permission settings? Review CLI permissions before saving.</p><div className="flex gap-2"><Button variant="outline" onClick={() => setConfirmCli(false)}>Keep ACP settings</Button><Button onClick={() => changeEngine("cli")}>Switch to CLI</Button></div></div>}
    <AgentRuntimeConfigSections showSectionTitles={false} fieldProps={{
      companyId, mode: "edit", isCreate: false, adapterType: native ? "paperclip_runner" : adapters[member.harness.type],
      values: null, set: null, config, models: [], hideModel: true, hideInstructionsFile: true, hideRunnerHarness: true, allowedConfigKeys,
      eff: (_group, _key, original) => original,
      mark: (_group, key, value) => {
        if (!allowedConfigKeys.has(key)) return;
        if (key === "engine") {
          if (value === "cli" && [settings.mode, settings.nonInteractivePermissions, settings.warmHandleIdleMs, settings.permissionMode].some(setting => setting !== undefined)) setConfirmCli(true);
          else changeEngine(value);
          return;
        }
        onChange({ adapterConfig: { ...settings, [key]: value } });
      },
    }} />
  </>} />;
}
