// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HttpConfigFields } from "./config-fields";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "http",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: false,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    envBindingsJson: "",
    url: "",
    httpMethod: "POST",
    httpHeadersJson: "",
    httpTimeoutMs: 15000,
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

function setNativeInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  const previous = input.value;
  valueSetter?.call(input, value);
  const tracker = (input as typeof input & { _valueTracker?: { setValue: (v: string) => void } })._valueTracker;
  tracker?.setValue(previous);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function renderWithTooltipProvider(container: HTMLDivElement, element: ReactNode) {
  const root = createRoot(container);
  act(() => {
    root.render(<TooltipProvider>{element}</TooltipProvider>);
  });
  return root;
}

describe("HttpConfigFields", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders the full operator-facing HTTP adapter field set", () => {
    const root = renderWithTooltipProvider(
      container,
        <HttpConfigFields
        mode="create"
        models={[]}
        adapterType="http"
        isCreate
        values={makeValues()}
        set={vi.fn()}
        config={{}}
        eff={(_scope, _key, fallback) => fallback}
        mark={vi.fn()}
      />,
    );

    expect(container.textContent).toContain("Webhook URL");
    expect(container.textContent).toContain("Method");
    expect(container.textContent).toContain("Timeout (ms)");
    expect(container.textContent).toContain("Headers JSON");
    expect(container.textContent).toContain("Payload template JSON");
    expect(container.textContent).toContain("Env bindings");

    act(() => root.unmount());
  });

  it("commits create-mode values for every HTTP-specific field", () => {
    const set = vi.fn();
    const root = renderWithTooltipProvider(
      container,
        <HttpConfigFields
        mode="create"
        models={[]}
        adapterType="http"
        isCreate
        values={makeValues()}
        set={set}
        config={{}}
        eff={(_scope, _key, fallback) => fallback}
        mark={vi.fn()}
      />,
    );

    const inputs = Array.from(container.querySelectorAll("input"));
    const select = container.querySelector("select");
    const textareas = Array.from(container.querySelectorAll("textarea"));

    act(() => {
      setNativeInputValue(inputs[0]!, "https://example.test/bridge");
    });
    act(() => {
      select!.value = "PATCH";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      setNativeInputValue(inputs[1]!, "600000");
    });
    act(() => {
      setNativeInputValue(textareas[0]!, '{"Content-Type":"application/json"}');
      textareas[0]!.blur();
    });
    act(() => {
      setNativeInputValue(textareas[1]!, '{"profile":"thomas"}');
      textareas[1]!.blur();
    });
    act(() => {
      setNativeInputValue(textareas[2]!, '{"BRIDGE_TOKEN":{"type":"secret_ref","secretId":"secret-1"}}');
      textareas[2]!.blur();
    });

    expect(set).toHaveBeenCalledWith({ url: "https://example.test/bridge" });
    expect(set).toHaveBeenCalledWith({ httpMethod: "PATCH" });
    expect(set).toHaveBeenCalledWith({ httpTimeoutMs: 600000 });
    expect(set).toHaveBeenCalledWith({ httpHeadersJson: '{"Content-Type":"application/json"}' });
    expect(set).toHaveBeenCalledWith({ payloadTemplateJson: '{"profile":"thomas"}' });
    expect(set).toHaveBeenCalledWith({ envBindingsJson: '{"BRIDGE_TOKEN":{"type":"secret_ref","secretId":"secret-1"}}' });

    act(() => root.unmount());
  });

  it("parses edit-mode JSON fields before marking adapter config", () => {
    const mark = vi.fn();
    const root = renderWithTooltipProvider(
      container,
        <HttpConfigFields
        mode="edit"
        models={[]}
        adapterType="http"
        isCreate={false}
        values={null}
        set={null}
        config={{
          url: "https://example.test/bridge",
          method: "POST",
          timeoutMs: 15000,
          headers: {},
          payloadTemplate: {},
          env: {},
        }}
        eff={(_scope, _key, fallback) => fallback}
        mark={mark}
      />,
    );

    const textareas = Array.from(container.querySelectorAll("textarea"));
    act(() => {
      setNativeInputValue(textareas[0]!, '{"Content-Type":"application/json"}');
      textareas[0]!.blur();
    });
    act(() => {
      setNativeInputValue(textareas[1]!, '{"timeoutSec":420}');
      textareas[1]!.blur();
    });
    act(() => {
      setNativeInputValue(textareas[2]!, '{"BRIDGE_TOKEN":{"type":"secret_ref","secretId":"secret-1"}}');
      textareas[2]!.blur();
    });

    expect(mark).toHaveBeenCalledWith("adapterConfig", "headers", { "Content-Type": "application/json" });
    expect(mark).toHaveBeenCalledWith("adapterConfig", "payloadTemplate", { timeoutSec: 420 });
    expect(mark).toHaveBeenCalledWith("adapterConfig", "env", { BRIDGE_TOKEN: { type: "secret_ref", secretId: "secret-1" } });

    act(() => root.unmount());
  });
});
