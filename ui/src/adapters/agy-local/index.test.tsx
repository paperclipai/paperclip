// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "../../components/ui/tooltip";
import { defaultCreateValues } from "../../components/agent-config-defaults";
import { agyLocalUIAdapter } from "./index";

vi.mock("../../components/PathInstructionsModal", () => ({
  ChoosePathButton: () => null,
}));
vi.mock("../../components/agent-config-primitives", () => ({
  DraftInput: ({ value }: { value?: string }) => <input value={value ?? ""} readOnly />,
  Field: ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <section>
      <span>{label}</span>
      {hint ? <p>{hint}</p> : null}
      {children}
    </section>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("agy_local UI adapter", () => {
  it("uses Antigravity-specific instructions copy", () => {
    const ConfigFields = agyLocalUIAdapter.ConfigFields;

    act(() => {
      root.render(
        <TooltipProvider>
          <ConfigFields
          mode="create"
          isCreate
          adapterType="agy_local"
          values={{ ...defaultCreateValues, adapterType: "agy_local" }}
            set={() => undefined}
            config={{}}
            eff={(_group, _field, original) => original}
            mark={() => undefined}
            models={[]}
          />
        </TooltipProvider>,
      );
    });

    expect(container.textContent).toContain("Antigravity prompt");
    expect(container.textContent).not.toContain("Gemini prompt");
  });
});
