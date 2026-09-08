// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AdapterConfigFieldsProps } from "./types";
import { SchemaConfigFields, invalidateConfigSchemaCache } from "./schema-config-fields";
import { TooltipProvider } from "../components/ui/tooltip";

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
    values: { adapterSchemaValues: {} } as AdapterConfigFieldsProps["values"], set,
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
