// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeLocalAdvancedFields } from "./claude-local/config-fields";
import { OpenCodeLocalConfigFields } from "./opencode-local/config-fields";

vi.mock("../../components/PathInstructionsModal", () => ({
  ChoosePathButton: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../local-workspace-runtime-fields", () => ({
  LocalWorkspaceRuntimeFields: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const editModeProps = {
  mode: "edit" as const,
  isCreate: false as const,
  values: null,
  set: null,
  models: [],
  hideInstructionsFile: false,
};

describe("skip permissions toggles", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("treats a missing Claude skip-permissions flag as disabled in edit mode", () => {
    const mark = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(
        <ClaudeLocalAdvancedFields
          {...editModeProps}
          adapterType="claude_local"
          config={{}}
          eff={(_group, _field, original) => original}
          mark={mark}
        />,
      );
    });

    const toggles = Array.from(container.querySelectorAll('button[data-slot="toggle"]'));
    const skipPermissionsToggle = toggles[1] as HTMLButtonElement | undefined;
    expect(skipPermissionsToggle).toBeDefined();
    expect(skipPermissionsToggle?.className).toContain("bg-muted");

    act(() => {
      skipPermissionsToggle?.click();
    });

    expect(mark).toHaveBeenCalledWith("adapterConfig", "dangerouslySkipPermissions", true);

    act(() => {
      root.unmount();
    });
  });

  it("treats a missing OpenCode skip-permissions flag as disabled in edit mode", () => {
    const mark = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(
        <OpenCodeLocalConfigFields
          {...editModeProps}
          adapterType="opencode_local"
          config={{}}
          eff={(_group, _field, original) => original}
          mark={mark}
        />,
      );
    });

    const toggle = container.querySelector('button[data-slot="toggle"]') as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle?.className).toContain("bg-muted");

    act(() => {
      toggle?.click();
    });

    expect(mark).toHaveBeenCalledWith("adapterConfig", "dangerouslySkipPermissions", true);

    act(() => {
      root.unmount();
    });
  });
});
