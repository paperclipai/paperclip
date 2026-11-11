import { useState } from "react";
import { Button } from "../ui/button";
import { resolveCodexLocalCliPolicy } from "@paperclipai/adapter-codex-local";
import { PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES } from "@paperclipai/adapter-utils";
import type { HarnessPoolMemberV2 } from "@paperclipai/shared";
import { ExecutionEngineField } from "../ExecutionEngineField";
import { Field, ToggleField, help } from "../agent-config-primitives";
import { Input } from "../ui/input";
import { SelectPopover } from "../ui/select";

type Settings = NonNullable<HarnessPoolMemberV2["adapterConfig"]>;
export function HarnessPoolRuntimeFields({ member, onChange }: {
  member: Omit<HarnessPoolMemberV2, "connection">;
  onChange: (patch: Partial<HarnessPoolMemberV2>) => void;
}) {
  const settings = member.adapterConfig ?? {};
  const [confirmCli, setConfirmCli] = useState(false);
  function changeEngine(engine: "auto" | "cli" | "acp") {
    const { mode: _mode, nonInteractivePermissions: _permissions, warmHandleIdleMs: _idle, permissionMode: _policy, ...common } = settings;
    onChange({ adapterConfig: engine === "cli" ? { ...common, engine } : { ...settings, engine } });
    setConfirmCli(false);
  }
  const native = member.runner !== "legacy";
  const claude = member.harness.type === "claude_code";
  const codex = member.harness.type === "codex";
  const permission = PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES[claude || member.harness.type === "grok" ? "acpx" : codex ? "codex" : "opencode"];
  const update = (key: keyof Settings, value: unknown) => onChange({ adapterConfig: { ...settings, [key]: value } });
  const choice = (label: string, key: keyof Settings, fallback: string, options: {value: string; label: string}[]) =>
    <Field label={label}><SelectPopover aria-label={label} value={String(settings[key] ?? fallback)} onValueChange={value => update(key, value)} options={options} /></Field>;
  const number = (label: string, key: keyof Settings, max: number, hint?: string) =>
    <Field label={label} hint={hint}><Input aria-label={label} type="number" min={0} max={max} step={1} value={settings[key] === undefined ? "" : String(settings[key])} placeholder="Use default" onChange={event => update(key, event.target.value === "" ? undefined : Number(event.target.value))} /></Field>;
  return <>
    <Field label="Runner" hint="Changing runner resets its execution settings. The model and account stay selected."><SelectPopover aria-label="Runner" value={member.runner ?? "paperclip"}
      onValueChange={value => onChange({ runner: value === "legacy" ? "legacy" : "paperclip", adapterConfig: undefined })}
      options={[{ value: "legacy", label: "Legacy" }, { value: "paperclip", label: "Paperclip Runner" }]} /></Field>
    {!native && (claude || codex) && <ExecutionEngineField harness={claude ? "claude" : "codex"} value={settings.engine ?? "auto"} onChange={value => { if (value === "cli" && [settings.mode, settings.nonInteractivePermissions, settings.warmHandleIdleMs, settings.permissionMode].some(setting => setting !== undefined)) setConfirmCli(true); else changeEngine(value); }} />}
    {confirmCli && <div className="space-y-2 text-sm"><p>Switch to CLI and remove ACP session and permission settings? Review CLI permissions before saving.</p><div className="flex gap-2"><Button variant="outline" onClick={() => setConfirmCli(false)}>Keep ACP settings</Button><Button onClick={() => changeEngine("cli")}>Switch to CLI</Button></div></div>}
    {!native && (claude || codex) && settings.engine !== "cli" && <>
      {choice("ACP session mode", "mode", "persistent", [{value:"persistent",label:"Persistent"},{value:"oneshot",label:"One-shot"}])}
      {choice("ACP non-interactive permissions", "nonInteractivePermissions", "deny", [{value:"deny",label:"Deny"},{value:"fail",label:"Fail"}])}
      {number("ACP warm handle idle (ms)", "warmHandleIdleMs", 86400000)}
    </>}
    {native && <>
      {choice("Runner lifecycle", "lifecycleMode", "per_turn", [{value:"per_turn",label:"Fresh process per turn"},{value:"warm",label:"Warm session"}])}
      {settings.lifecycleMode === "warm" && number("Runner idle timeout (ms)", "idleTimeoutMs", 86400000)}
      {permission.configurable && choice("Permission mode", permission.configKey as keyof Settings, permission.defaultMode, permission.options.map(option => ({value:option.value,label:option.label})))}
    </>}
    {!native && claude && settings.engine !== "cli" && choice("Permissions", "permissionMode", "approve-all", [{value:"approve-all",label:"Approve all"},{value:"approve-reads",label:"Approve reads"},{value:"deny-all",label:"Deny all"}])}
    {!native && claude && <>
      <ToggleField label="Chrome" hint={help.chrome} checked={settings.chrome === true} onChange={value => update("chrome", value)} />
      {number("Max turns per run", "maxTurnsPerRun", 100000, help.maxTurnsPerRun)}
    </>}
    {!native && (claude || member.harness.type === "opencode") && <ToggleField label="Skip permissions" hint={help.dangerouslySkipPermissions} checked={settings.dangerouslySkipPermissions !== false} onChange={value => update("dangerouslySkipPermissions", value)} />}
    {!native && codex && <>
      <ToggleField label="Fast mode" hint={help.fastMode} checked={settings.fastMode === true} onChange={value => update("fastMode", value)} />
      <ToggleField label="Bypass approvals and sandbox" hint={help.dangerouslyBypassSandbox} checked={resolveCodexLocalCliPolicy(settings).bypass} onChange={value => update("dangerouslyBypassApprovalsAndSandbox", value)} />
    </>}
    {number("Timeout (seconds)", "timeoutSec", 86400, help.timeoutSec)}
    {number("Interrupt grace (seconds)", "graceSec", 86400, help.graceSec)}
  </>;
}
