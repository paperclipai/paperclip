// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HermesGatewayConfigFields } from "./config-fields";
import type { AdapterConfigFieldsProps } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderFields(overrides: Partial<AdapterConfigFieldsProps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const mark = vi.fn();
  const set = vi.fn();
  const props: AdapterConfigFieldsProps = {
    mode: "edit",
    isCreate: false,
    adapterType: "hermes_gateway",
    values: null,
    set: null,
    config: {},
    eff: (_group, _field, original) => original,
    mark,
    models: [],
    ...overrides,
  };

  act(() => {
    root.render(
      <TooltipProvider>
        <HermesGatewayConfigFields {...props} />
      </TooltipProvider>,
    );
  });

  return { container, root, mark, set };
}

describe("HermesGatewayConfigFields", () => {
  const roots: Root[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("shows the gateway URL and runtime fields in edit mode", () => {
    const result = renderFields({
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" },
        paperclipApiUrl: "http://127.0.0.1:3100",
        sessionKeyStrategy: "issue",
      },
    });
    roots.push(result.root);

    const text = result.container.textContent ?? "";
    expect(text).toContain("API base URL");
    expect(text).toContain("API key");
    expect(text).toContain("Paperclip API URL");
    expect(text).toContain("Existing Hermes session ID");
    expect(text).toContain("Session key strategy");
    expect(text).toContain("Timeout seconds");
    expect(text).toContain("Event reconnect ms");
    expect(text).toContain("Dangerously allow remote HTTP");
    expect(text).toContain("Extra headers");
    expect(text).toContain("Instructions");

    const urlInput = result.container.querySelector<HTMLInputElement>('input[value="http://127.0.0.1:8642"]');
    expect(urlInput).toBeTruthy();

    const apiKeyInput = Array.from(result.container.querySelectorAll<HTMLInputElement>('input[type="password"]'))
      .find((input) => input.placeholder.includes("Stored secret"));
    expect(apiKeyInput).toBeTruthy();

    expect(result.container.querySelector('button[aria-label="Show API key"]')).toBeTruthy();
  });

  it("shows a configured existing Hermes session id and commits edits without touching secrets", async () => {
    const result = renderFields({
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        existingHermesSessionId: "20260101_120000_abcd",
      },
    });
    roots.push(result.root);

    const input = result.container.querySelector<HTMLInputElement>(
      'input[placeholder="20260101_120000_abcd"]',
    );
    expect(input).toBeTruthy();
    expect(input!.value).toBe("20260101_120000_abcd");

    // Edit-mode commit routes through mark("adapterConfig", key, value).
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "20260101_130000_e2tg");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(result.mark).toHaveBeenCalledWith(
      "adapterConfig",
      "existingHermesSessionId",
      "20260101_130000_e2tg",
    );
  });

  it("writes an explicit session id on create and omits it when left empty", async () => {
    // renderFields defaults set to null; create mode needs an explicit mock.
    const set = vi.fn();
    const result = renderFields({ isCreate: true, set });
    roots.push(result.root);

    const input = result.container.querySelector<HTMLInputElement>(
      'input[placeholder="20260101_120000_abcd"]',
    );
    expect(input).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "20260101_120000_e2tg");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(set).toHaveBeenCalledWith({
      adapterSchemaValues: { existingHermesSessionId: "20260101_120000_e2tg" },
    });

    // Clearing the field drops the key entirely: old configs without the
    // field, and emptied ones, keep the default isolated behavior.
    set.mockClear();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(set).toHaveBeenCalledWith({
      adapterSchemaValues: { existingHermesSessionId: undefined },
    });
  });
});
