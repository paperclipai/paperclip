// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonSchemaForm } from "./JsonSchemaForm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// SecretBindingPicker pulls in CompanyContext + react-query. Stub it so we can
// exercise SecretField in isolation. The stub renders a select with the same
// onChange contract as the real picker.
vi.mock("./SecretBindingPicker", () => ({
  SecretBindingPicker: ({
    value,
    onChange,
    disabled,
  }: {
    value: { secretId: string } | null;
    onChange: (next: { secretId: string } | null) => void;
    disabled?: boolean;
  }) => (
    <select
      data-testid="secret-binding-picker"
      value={value?.secretId ?? ""}
      onChange={(event) => {
        const next = event.target.value;
        onChange(next ? { secretId: next } : null);
      }}
      disabled={disabled}
    >
      <option value="">none</option>
      <option value="11111111-1111-4111-8111-111111111111">existing-secret</option>
    </select>
  ),
}));

describe("JsonSchemaForm secret-ref rendering", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders multiline secret-ref fields as textareas alongside the picker", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={{
            type: "object",
            properties: {
              sshPrivateKey: {
                type: "string",
                format: "secret-ref",
                maxLength: 4096,
              },
            },
          }}
          values={{ sshPrivateKey: "secret" }}
          onChange={() => {}}
        />,
      );
    });

    // The picker is always rendered, and a non-UUID raw value auto-opens the
    // textarea fallback.
    expect(container.querySelector('[data-testid="secret-binding-picker"]')).not.toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("renders the picker and hides the raw input when the value is a UUID secret ref", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={{
            type: "object",
            properties: {
              apiKey: {
                type: "string",
                format: "secret-ref",
              },
            },
          }}
          values={{ apiKey: "11111111-1111-4111-8111-111111111111" }}
          onChange={() => {}}
        />,
      );
    });

    expect(
      container.querySelector('[data-testid="secret-binding-picker"]'),
    ).not.toBeNull();
    // No raw input or textarea is visible while a secret is bound.
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("writes the secret id to form values when the picker selects an existing secret", async () => {
    const root = createRoot(container);
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={{
            type: "object",
            properties: {
              apiKey: {
                type: "string",
                format: "secret-ref",
              },
            },
          }}
          values={{ apiKey: "" }}
          onChange={onChange}
        />,
      );
    });

    const picker = container.querySelector<HTMLSelectElement>(
      '[data-testid="secret-binding-picker"]',
    );
    expect(picker).not.toBeNull();

    const setSelectValue = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )?.set;
    expect(setSelectValue).toBeTruthy();

    await act(async () => {
      setSelectValue!.call(picker!, "11111111-1111-4111-8111-111111111111");
      picker!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({
      apiKey: "11111111-1111-4111-8111-111111111111",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("auto-opens the raw input when a raw value arrives after mount", async () => {
    const root = createRoot(container);

    const schema = {
      type: "object" as const,
      properties: {
        apiKey: {
          type: "string" as const,
          format: "secret-ref" as const,
        },
      },
    };

    // First render with empty value — picker visible, no raw input.
    await act(async () => {
      root.render(
        <JsonSchemaForm schema={schema} values={{ apiKey: "" }} onChange={() => {}} />,
      );
    });
    expect(container.querySelector('input[type="password"]')).toBeNull();

    // Parent fills in a previously-saved raw value (the async load case).
    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={schema}
          values={{ apiKey: "loaded-from-api" }}
          onChange={() => {}}
        />,
      );
    });

    const input = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(input).not.toBeNull();
    expect(input?.value).toBe("loaded-from-api");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the password fallback for short raw values", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={{
            type: "object",
            properties: {
              apiKey: {
                type: "string",
                format: "secret-ref",
              },
            },
          }}
          values={{ apiKey: "raw-value" }}
          onChange={() => {}}
        />,
      );
    });

    const input = container.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    expect(input).not.toBeNull();
    expect(input?.value).toBe("raw-value");

    await act(async () => {
      root.unmount();
    });
  });
});
