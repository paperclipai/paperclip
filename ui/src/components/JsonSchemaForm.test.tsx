// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonSchemaForm, getDefaultValues } from "./JsonSchemaForm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Radix Select relies on PointerEvent, pointer capture, and ResizeObserver,
// none of which jsdom implements. Stub them so the dropdown can open in tests.
if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}
if (typeof Element !== "undefined" && !Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
}
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

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

  it("renders no Advanced disclosure when no field opts in", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={{
            type: "object",
            properties: {
              apiKey: { type: "string", format: "secret-ref" },
              region: { type: "string" },
            },
          }}
          values={{ apiKey: "", region: "" }}
          onChange={() => {}}
        />,
      );
    });

    // No disclosure button should be present in the passthrough case.
    const buttons = Array.from(container.querySelectorAll("button"));
    const advancedButton = buttons.find((b) =>
      b.textContent?.includes("Advanced options"),
    );
    expect(advancedButton).toBeUndefined();

    // Both fields render in the flat layout: the secret picker (rendered as
    // a <select> stub) for apiKey and a text input for region.
    expect(
      container.querySelector('[data-testid="secret-binding-picker"]'),
    ).not.toBeNull();
    expect(container.querySelector('input[type="text"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("hides advanced fields behind a collapsed disclosure with group headings", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={{
            type: "object",
            properties: {
              apiKey: { type: "string", format: "secret-ref" },
              sshPort: {
                type: "number",
                "x-paperclip-advanced": true,
                "x-paperclip-group": "SSH access",
              },
              namePrefix: {
                type: "string",
                "x-paperclip-advanced": true,
              },
            },
          }}
          values={{ apiKey: "", sshPort: 22, namePrefix: "paperclip" }}
          onChange={() => {}}
        />,
      );
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    const advancedButton = buttons.find((b) =>
      b.textContent?.includes("Advanced options"),
    );
    expect(advancedButton).toBeDefined();
    expect(advancedButton!.getAttribute("aria-expanded")).toBe("false");

    // Collapsed: number/text inputs from advanced fields aren't rendered.
    expect(container.querySelector('input[type="number"]')).toBeNull();
    // Group headings aren't visible while collapsed.
    expect(container.textContent).not.toContain("SSH access");
    expect(container.textContent).not.toContain("More options");

    // Expand and verify both groups + the default bucket appear.
    await act(async () => {
      advancedButton!.click();
    });

    expect(advancedButton!.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('input[type="number"]')).not.toBeNull();
    expect(container.textContent).toContain("SSH access");
    expect(container.textContent).toContain("More options");

    await act(async () => {
      root.unmount();
    });
  });

  it("force-opens the disclosure when an error lands on a hidden advanced field", async () => {
    const root = createRoot(container);

    const schema = {
      type: "object" as const,
      properties: {
        apiKey: { type: "string" as const, format: "secret-ref" as const },
        sshPort: {
          type: "number" as const,
          "x-paperclip-advanced": true,
        },
      },
    };

    // No errors -> collapsed
    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={schema}
          values={{ apiKey: "", sshPort: 22 }}
          onChange={() => {}}
        />,
      );
    });

    let advancedButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Advanced options"),
    );
    expect(advancedButton!.getAttribute("aria-expanded")).toBe("false");

    // Submit validation error on the hidden advanced field -> forced open
    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={schema}
          values={{ apiKey: "", sshPort: 22 }}
          onChange={() => {}}
          errors={{ "/sshPort": "Must be at least 1" }}
        />,
      );
    });

    advancedButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Advanced options"),
    );
    expect(advancedButton!.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Must be at least 1");

    await act(async () => {
      root.unmount();
    });
  });

  it("omits optional scalar fields from getDefaultValues so empty inputs aren't submitted as 0/''", () => {
    const defaults = getDefaultValues({
      type: "object",
      properties: {
        apiKey: { type: "string", format: "secret-ref" },
        sshPort: { type: "number", default: 22 },
        cpu: { type: "number" },
        memory: { type: "string" },
        size: { type: "string", enum: ["small", "large"] },
        reuseLease: { type: "boolean", default: false },
        tags: { type: "array", items: { type: "string" } },
      },
    });

    // Fields with explicit defaults round-trip.
    expect(defaults.sshPort).toBe(22);
    expect(defaults.reuseLease).toBe(false);
    expect(defaults.tags).toEqual([]);

    // Optional scalars without explicit defaults stay out of the payload so
    // the server doesn't see e.g. `cpu: 0` and reject the submission.
    expect("apiKey" in defaults).toBe(false);
    expect("cpu" in defaults).toBe(false);
    expect("memory" in defaults).toBe(false);
    expect("size" in defaults).toBe(false);
  });

  it("renders datalist suggestions for numeric fields when examples are present", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={{
            type: "object",
            properties: {
              memory: {
                type: "integer",
                examples: [1, 2, 4, 8],
              },
            },
          }}
          values={{}}
          onChange={() => {}}
        />,
      );
    });

    const input = container.querySelector<HTMLInputElement>('input[type="number"]');
    // The "/" in the field path is sanitized so the id is a valid CSS/HTML identifier.
    expect(input?.getAttribute("list")).toBe("-memory-suggestions");
    expect(container.querySelector("datalist")?.getAttribute("id")).toBe("-memory-suggestions");
    const options = Array.from(container.querySelectorAll("datalist option")).map((option) =>
      option.getAttribute("value"),
    );
    expect(options).toEqual(["1", "2", "4", "8"]);

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

describe("JsonSchemaForm enum rendering", () => {
  let container: HTMLDivElement;

  const numericEnumSchema = {
    type: "object" as const,
    properties: {
      memory: {
        type: "integer" as const,
        enum: [1, 2, 4, 8],
      },
    },
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function openSelect() {
    const trigger = container.querySelector<HTMLElement>('[role="combobox"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function optionByLabel(label: string): Element | undefined {
    return Array.from(document.querySelectorAll('[role="option"]')).find(
      (option) => option.textContent?.trim() === label,
    );
  }

  it("renders an optional numeric enum as a dropdown with a blank row and no 0", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <JsonSchemaForm schema={numericEnumSchema} values={{}} onChange={() => {}} />,
      );
    });

    await openSelect();

    const labels = Array.from(document.querySelectorAll('[role="option"]')).map(
      (option) => option.textContent?.trim(),
    );
    // A blank "None" row is offered so the user can express "not configured".
    expect(labels).toContain("None");
    expect(labels).toEqual(expect.arrayContaining(["1", "2", "4", "8"]));
    // 0 is not a valid Daytona memory size and must never appear.
    expect(labels).not.toContain("0");

    await act(async () => {
      root.unmount();
    });
  });

  it("selects the blank row by default when no value is configured", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <JsonSchemaForm schema={numericEnumSchema} values={{}} onChange={() => {}} />,
      );
    });

    await openSelect();

    const noneOption = optionByLabel("None");
    expect(noneOption).toBeTruthy();
    // Radix marks the active selection with aria-selected / data-state checked.
    expect(noneOption?.getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      root.unmount();
    });
  });

  it("coerces the selected numeric enum value back to a number", async () => {
    const onChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <JsonSchemaForm schema={numericEnumSchema} values={{}} onChange={onChange} />,
      );
    });

    await openSelect();

    await act(async () => {
      optionByLabel("2")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Number, not the string "2", so server-side integer validation passes.
    expect(onChange).toHaveBeenCalledWith({ memory: 2 });

    await act(async () => {
      root.unmount();
    });
  });

  it("maps the blank row back to an unset (undefined) value", async () => {
    const onChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={numericEnumSchema}
          values={{ memory: 2 }}
          onChange={onChange}
        />,
      );
    });

    await openSelect();

    await act(async () => {
      optionByLabel("None")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({ memory: undefined });

    await act(async () => {
      root.unmount();
    });
  });
});
