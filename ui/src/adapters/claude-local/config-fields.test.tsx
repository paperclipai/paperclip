// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { buildClaudeLocalConfig } from "@paperclipai/adapter-claude-local/ui";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { defaultCreateValues } from "@/components/agent-config-defaults";
import { ClaudeLocalAdvancedFields } from "./config-fields";

vi.mock("../local-workspace-runtime-fields", () => ({ LocalWorkspaceRuntimeFields: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => { document.body.replaceChildren(); });

it.each(["create", "edit"] as const)("saves each profile import choice in %s mode without losing environment bindings", async (mode) => {
  const secret = { type: "secret_ref", secretId: "agent-secret", version: "latest" };
  const original = { env: { KEEP_SECRET: secret, PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE: "cache" } };
  let saved: Record<string, unknown> = {};
  function Harness() {
    const [config, setConfig] = useState<Record<string, unknown>>(original);
    const [values, setValues] = useState<CreateConfigValues>({
      ...defaultCreateValues,
      envBindings: { KEEP_SECRET: secret },
      envVars: "KEEP_LEGACY=preserved\nPAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE=cache",
    });
    saved = mode === "create" ? buildClaudeLocalConfig(values) : config;
    return <TooltipProvider><ClaudeLocalAdvancedFields
      section="runPolicy" mode={mode} isCreate={mode === "create"} adapterType="claude_local"
      values={values} set={(patch) => setValues((previous) => ({ ...previous, ...patch }))}
      config={config} eff={(_group, key, fallback) => (config[key] ?? fallback) as typeof fallback}
      mark={(_group, key, value) => setConfig((previous) => ({ ...previous, [key]: value }))}
      models={[]} hideInstructionsFile
    /></TooltipProvider>;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    const select = container.querySelector<HTMLSelectElement>("select[aria-label='Local Claude skills and plugins']")!;
    expect(select.value).toBe("inherit");
    expect(select.textContent).toContain("currently cache");
    for (const value of ["off", "copy", "cache"]) {
      await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
      expect(saved.profileImportMode).toBe(value);
      expect(saved.env).toMatchObject({
        KEEP_SECRET: secret,
        ...(mode === "create" ? { KEEP_LEGACY: { type: "plain", value: "preserved" } } : {}),
      });
    }
    expect(original.env.PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE).toBe("cache");
    const retention = container.querySelector<HTMLSelectElement>("select[aria-label='Keep Claude session transcripts']")!;
    for (const value of ["on", "off"]) {
      await act(async () => { retention.value = value; retention.dispatchEvent(new Event("change", { bubbles: true })); });
      expect(saved.transcriptRetentionEnabled).toBe(value === "on");
    }
    const source = container.querySelector<HTMLInputElement>("input[placeholder='Automatic / existing environment setting']")!;
    const days = container.querySelector<HTMLInputElement>("input[aria-label='Claude transcript retention days']")!;
    for (const [input, value] of [[source, "C:/trusted-profile"], [days, "14"]] as const) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    expect(saved.profileSourceDir).toBe("C:/trusted-profile");
    expect(saved.transcriptRetentionDays).toBe(14);
  } finally {
    await act(async () => root.unmount());
  }
});

it("previews redacted environment defaults without pinning them when the environment changes", async () => {
  const original = { env: { PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE: "***REDACTED***" } };
  let saved: Record<string, unknown> = original;
  function Harness() {
    const [env, setEnv] = useState<Record<string, unknown>>(original.env);
    saved = { ...original, env };
    return <TooltipProvider>
      <button onClick={() => setEnv({ PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE: "off" })}>Change environment</button>
      <ClaudeLocalAdvancedFields section="runPolicy" mode="edit" isCreate={false} adapterType="claude_local"
        config={original} values={null} set={null} displayDefaults={{ profileImportMode: "cache" }}
        eff={(_group, key, fallback) => (key === "env" ? env : fallback) as typeof fallback}
        mark={vi.fn()} models={[]} hideInstructionsFile />
    </TooltipProvider>;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    const select = container.querySelector<HTMLSelectElement>("select[aria-label='Local Claude skills and plugins']")!;
    expect(select.value).toBe("inherit");
    expect(select.textContent).toContain("currently cache");
    expect(saved).not.toHaveProperty("profileImportMode");
    await act(async () => container.querySelector("button")!.click());
    expect(select.value).toBe("inherit");
    expect(select.textContent).toContain("currently off");
    expect(saved).not.toHaveProperty("profileImportMode");
  } finally {
    await act(async () => root.unmount());
  }
});
