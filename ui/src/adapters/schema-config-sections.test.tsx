// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AdapterConfigFieldsProps } from "./types";
import { SchemaConfigFields, invalidateConfigSchemaCache } from "./schema-config-fields";
import { TooltipProvider } from "../components/ui/tooltip";
import { defaultCreateValues } from "../components/agent-config-defaults";

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("drops the old schema immediately when the adapter changes and applies new create defaults", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const firstType = "section-test-first";
  const secondType = "section-test-second";
  invalidateConfigSchemaCache(firstType);
  invalidateConfigSchemaCache(secondType);
  let resolveSecond!: (value: unknown) => void;
  const secondResponse = new Promise((resolve) => { resolveSecond = resolve; });
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ fields: [{ key: "first", label: "First setting", type: "text", default: "first-default" }] }) })
    .mockReturnValueOnce(secondResponse));
  const set = vi.fn();
  const props: AdapterConfigFieldsProps = {
    mode: "create", isCreate: true, adapterType: firstType, section: "configuration",
    values: { ...defaultCreateValues, adapterSchemaValues: {} }, set,
    config: {}, eff: (_group, _field, original) => original, mark: vi.fn(), models: [],
  };
  const view = (adapterType: string) => <TooltipProvider><SchemaConfigFields {...props} adapterType={adapterType} /></TooltipProvider>;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(view(firstType)));
  expect(container.textContent).toContain("First setting");
  expect(set).toHaveBeenCalledWith({ adapterSchemaValues: { first: "first-default" } });
  await act(async () => root?.render(view(secondType)));
  expect(container.textContent).not.toContain("First setting");
  await act(async () => resolveSecond({ ok: true, json: async () => ({ fields: [{ key: "second", label: "Second setting", type: "text", default: "second-default" }] }) }));
  expect(container.textContent).toContain("Second setting");
  expect(set).toHaveBeenLastCalledWith({ adapterSchemaValues: { second: "second-default" } });
});


it("restores cleared defaults after switching back before the intermediate schema loads", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const firstType = "rapid-switch-first";
  const secondType = "rapid-switch-second";
  invalidateConfigSchemaCache(firstType);
  invalidateConfigSchemaCache(secondType);
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ fields: [{ key: "model", label: "Model", type: "text", default: "default-model" }] }) })
    .mockReturnValueOnce(new Promise(() => {})));
  const set = vi.fn();
  const props: AdapterConfigFieldsProps = {
    mode: "create", isCreate: true, adapterType: firstType, section: "configuration",
    values: { ...defaultCreateValues, adapterSchemaValues: { model: "chosen-model" } }, set,
    config: {}, eff: (_group, _field, original) => original, mark: vi.fn(), models: [],
  };
  const view = (adapterType: string) => <TooltipProvider><SchemaConfigFields {...props} adapterType={adapterType} /></TooltipProvider>;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(view(firstType)));
  expect(set).toHaveBeenLastCalledWith({ adapterSchemaValues: { model: "chosen-model" } });
  props.values = { ...defaultCreateValues, adapterSchemaValues: {} };
  await act(async () => root?.render(view(secondType)));
  set.mockClear();
  await act(async () => root?.render(view(firstType)));
  expect(set).toHaveBeenCalledExactlyOnceWith({ adapterSchemaValues: { model: "default-model" } });
});

it("filters schema UI and create defaults by allowed configuration keys", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const adapterType = "allowed-runtime-fields";
  invalidateConfigSchemaCache(adapterType);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ fields: [
    { key: "mode", label: "Session mode", type: "text", default: "persistent" },
    { key: "env", label: "Environment secrets", type: "text", default: "secret" },
    { key: "command", label: "Host command", type: "text", default: "host-command" },
  ] }) }));
  const set = vi.fn(); const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(<TooltipProvider><SchemaConfigFields mode="create" isCreate adapterType={adapterType} allowedConfigKeys={new Set(["mode"])} values={{ ...defaultCreateValues, adapterSchemaValues: {} }} set={set} config={{}} eff={(_group, _key, original) => original} mark={vi.fn()} models={[]} /></TooltipProvider>));
  expect(container.textContent).toContain("Session mode"); expect(container.textContent).not.toContain("Environment secrets"); expect(container.textContent).not.toContain("Host command");
  expect(set).toHaveBeenCalledExactlyOnceWith({ adapterSchemaValues: { mode: "persistent" } });
});
