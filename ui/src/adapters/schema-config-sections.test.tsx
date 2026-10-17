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

it("places a field in the section that its meta.section names", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const adapterType = "section-test-declared";
  invalidateConfigSchemaCache(adapterType);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ fields: [
    { key: "reasoningEffort", label: "Reasoning level", type: "text", meta: { section: "adapter" } },
    { key: "notes", label: "Notes", type: "text", meta: { section: "not-a-section" } },
  ] }) }));
  const props: AdapterConfigFieldsProps = {
    mode: "edit", isCreate: false, adapterType, values: null, set: null,
    config: {}, eff: (_group, _field, original) => original, mark: vi.fn(), models: [],
  };
  const view = (section: AdapterConfigFieldsProps["section"]) => <TooltipProvider><SchemaConfigFields {...props} section={section} /></TooltipProvider>;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(view("adapter")));
  expect(container.textContent).toContain("Reasoning level");
  expect(container.textContent).not.toContain("Notes");
  await act(async () => root?.render(view("configuration")));
  expect(container.textContent).not.toContain("Reasoning level");
  expect(container.textContent).toContain("Notes");
});
