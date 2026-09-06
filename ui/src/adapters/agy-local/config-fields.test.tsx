// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AgyLocalConfigFields } from "./config-fields";
import type { AdapterConfigFieldsProps } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderAgyStatic(config: Record<string, unknown>): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <AgyLocalConfigFields
        mode="edit"
        isCreate={false}
        adapterType="agy_local"
        values={null}
        set={null}
        config={config}
        eff={(_group, _field, original) => original}
        mark={() => undefined}
        models={[]}
        hideInstructionsFile
      />
    </TooltipProvider>,
  );
}

function renderFields(overrides: Partial<AdapterConfigFieldsProps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const mark = vi.fn();
  const set = vi.fn();
  const props: AdapterConfigFieldsProps = {
    mode: "edit",
    isCreate: false,
    adapterType: "agy_local",
    values: null,
    set,
    config: {},
    eff: (_group, _field, original) => original,
    mark,
    models: [],
    ...overrides,
  };

  act(() => {
    root.render(
      <TooltipProvider>
        <AgyLocalConfigFields {...props} />
      </TooltipProvider>,
    );
  });

  return { container, root, mark, set };
}

describe("AgyLocalConfigFields", () => {
  const roots: Root[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("defaults mode dropdown to accept-edits when mode is unset", () => {
    const html = renderAgyStatic({});
    expect(html).toContain('<option value="accept-edits" selected="">Edit Mode (accept-edits) — Full autonomous execution</option>');
    expect(html).toContain('<option value="plan">Plan Mode (plan) — Non-mutating planning &amp; research</option>');
  });

  it("selects plan mode when configured as plan", () => {
    const html = renderAgyStatic({ mode: "plan" });
    expect(html).toContain('<option value="plan" selected="">Plan Mode (plan) — Non-mutating planning &amp; research</option>');
  });

  it("selects accept-edits mode when explicitly configured as accept-edits", () => {
    const html = renderAgyStatic({ mode: "accept-edits" });
    expect(html).toContain('<option value="accept-edits" selected="">Edit Mode (accept-edits) — Full autonomous execution</option>');
  });

  it("stores the explicit mode string on change in edit mode", () => {
    const result = renderFields({
      config: { mode: "plan" },
    });
    roots.push(result.root);

    const select = result.container.querySelector("select");
    expect(select).not.toBeNull();

    act(() => {
      select!.value = "accept-edits";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(result.mark).toHaveBeenCalledWith("adapterConfig", "mode", "accept-edits");

    act(() => {
      select!.value = "plan";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(result.mark).toHaveBeenCalledWith("adapterConfig", "mode", "plan");
  });

  it("stores the explicit mode string on change in create mode", () => {
    const result = renderFields({
      mode: "create",
      isCreate: true,
      values: {} as any,
    });
    roots.push(result.root);

    const select = result.container.querySelector("select");
    expect(select).not.toBeNull();

    act(() => {
      select!.value = "accept-edits";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(result.set).toHaveBeenCalledWith({ mode: "accept-edits" });

    act(() => {
      select!.value = "plan";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(result.set).toHaveBeenCalledWith({ mode: "plan" });
  });
});
