// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenClawGatewayConfigFields } from "./config-fields";

vi.mock("../../components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("../runtime-json-fields", () => ({
  PayloadTemplateJsonField: () => null,
  RuntimeServicesJsonField: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderFields(effValue: Record<string, unknown> | undefined) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const mark = vi.fn();

  act(() => {
    root.render(
      <OpenClawGatewayConfigFields
        mode="edit"
        isCreate={false}
        adapterType="openclaw_gateway"
        values={null}
        set={null}
        config={{
          url: "ws://gateway",
          headers: {},
          issueBlockEscalation: {
            enabled: true,
            targetRole: "cto",
          },
        }}
        eff={(_group, field, original) => {
          if (field === "issueBlockEscalation") {
            return (effValue as typeof original) ?? original;
          }
          return original;
        }}
        mark={mark}
        models={[]}
      />,
    );
  });

  return {
    container,
    root,
    mark,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("OpenClawGatewayConfigFields", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("reflects a disabled issueBlockEscalation overlay instead of stale saved config", () => {
    const view = renderFields({});

    const toggle = view.container.querySelector('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(view.container.querySelector('input[placeholder="cto"]')).toBeNull();

    view.cleanup();
  });

  it("reads the targetRole field from the overlay while editing", () => {
    const view = renderFields({
      enabled: true,
      targetRole: "senior_engineer",
    });

    const targetRoleInput = view.container.querySelector('input[placeholder="cto"]') as HTMLInputElement | null;
    expect(targetRoleInput?.value).toBe("senior_engineer");
    expect(view.container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");

    view.cleanup();
  });
});
