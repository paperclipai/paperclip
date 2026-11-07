// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JsonSchemaForm,
  type JsonSchemaNode,
  getArrayItemLabel,
  getDefaultValues,
  summarizeArrayItem,
  validateJsonSchemaForm,
} from "./JsonSchemaForm";

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

  it("writes a secret_ref binding to form values when the picker selects an existing secret", async () => {
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
      apiKey: {
        type: "secret_ref",
        secretId: "11111111-1111-4111-8111-111111111111",
        version: "latest",
      },
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

describe("JsonSchemaForm optional nested objects", () => {
  const schema: JsonSchemaNode = {
    type: "object",
    properties: {
      url: { type: "string" },
      profile: {
        type: "object",
        required: ["Name"],
        properties: {
          Name: { type: "string" },
          locale: { type: "string" },
        },
      },
      queryOptions: {
        type: "object",
        required: ["Prompt"],
        properties: {
          Prompt: { type: "string" },
          mode: { type: "string" },
        },
      },
      screenshotOptions: {
        type: "object",
        properties: {
          viewport: {
            type: "object",
            required: ["Width", "Height"],
            properties: {
              Width: { type: "integer" },
              Height: { type: "integer" },
            },
          },
        },
      },
    },
  };

  it("omits untouched optional object trees and accepts their defaults", () => {
    const defaults = getDefaultValues(schema);

    expect(defaults).toEqual({});
    expect(validateJsonSchemaForm(schema, defaults)).toEqual({});
    expect(
      validateJsonSchemaForm(schema, {
        profile: {},
        queryOptions: {},
        screenshotOptions: { viewport: {} },
      }),
    ).toEqual({
      "/profile/Name": "This field is required",
      "/queryOptions/Prompt": "This field is required",
      "/screenshotOptions/viewport/Width": "This field is required",
      "/screenshotOptions/viewport/Height": "This field is required",
    });

    const nestedSchema: JsonSchemaNode = {
      type: "object",
      required: ["config"],
      properties: {
        config: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            queryOptions: {
              type: "object",
              required: ["Prompt"],
              properties: { Prompt: { type: "string" } },
            },
          },
        },
      },
    };
    const nestedDefaults = getDefaultValues(nestedSchema);
    expect(nestedDefaults).toEqual({ config: { enabled: false } });
    expect(validateJsonSchemaForm(nestedSchema, nestedDefaults)).toEqual({});
  });

  it("validates required descendants once an optional object is populated", () => {
    expect(
      validateJsonSchemaForm(schema, {
        profile: { locale: "en" },
        queryOptions: { mode: "search" },
        screenshotOptions: { viewport: { Width: 1280 } },
      }),
    ).toEqual({
      "/profile/Name": "This field is required",
      "/queryOptions/Prompt": "This field is required",
      "/screenshotOptions/viewport/Height": "This field is required",
    });
  });
});

describe("JsonSchemaForm arrays of objects", () => {
  const SECRET = { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" };
  const schema: JsonSchemaNode = {
    type: "object",
    properties: {
      backends: {
        type: "array",
        title: "Backends",
        "x-paperclip-itemLabel": "name",
        "x-paperclip-itemSummary": ["type", "baseUrl", "key"],
        items: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            type: { type: "string", enum: ["litellm", "ollama", "llama-server"] },
            baseUrl: { type: "string" },
            key: { format: "secret-ref" },
            slots: { type: "integer" },
          },
        },
      },
    },
  };
  const backends = [
    { id: "proxy", name: "LiteLLM proxy", type: "litellm", baseUrl: "https://ai.example.com/v1", key: SECRET, slots: 8 },
    { id: "vm", name: "VM", type: "llama-server", baseUrl: "http://10.0.0.5:8080", slots: 1 },
    { id: "mbp", name: "MacBook", type: "ollama", baseUrl: "http://mbp.local:11434", slots: 4 },
    { id: "spare", type: "ollama" },
  ];

  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const entryButtons = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]:not([role=\"combobox\"])"));

  it("labels entries from the named property and falls back to Item N", () => {
    const arraySchema = schema.properties!.backends;
    expect(getArrayItemLabel(arraySchema, backends[0], 0)).toBe("LiteLLM proxy");
    expect(getArrayItemLabel(arraySchema, backends[3], 3)).toBe("Item 4");
    expect(getArrayItemLabel(arraySchema, { name: "  " }, 1)).toBe("Item 2");
    expect(getArrayItemLabel({ type: "array", items: { type: "object" } }, backends[0], 0)).toBe("Item 1");
  });

  it("summarizes the listed properties, with URL hosts and a set-secret mark", () => {
    const arraySchema = schema.properties!.backends;
    expect(summarizeArrayItem(arraySchema, backends[0])).toBe("litellm · ai.example.com · key ✓");
    expect(summarizeArrayItem(arraySchema, backends[1])).toBe("llama-server · 10.0.0.5:8080");
    // Without x-paperclip-itemSummary: the first three scalar values, skipping the label property.
    const { "x-paperclip-itemSummary": _omit, ...defaults } = arraySchema;
    expect(summarizeArrayItem(defaults, backends[0])).toBe("proxy · litellm · ai.example.com");
  });

  it("renders entries collapsed to a labeled summary line", async () => {
    await act(async () => {
      root.render(<JsonSchemaForm schema={schema} values={{ backends }} onChange={() => {}} />);
    });

    const buttons = entryButtons();
    expect(buttons.map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "false", "false", "false"]);
    expect(buttons.map((b) => b.textContent)).toEqual([
      "LiteLLM proxy· litellm · ai.example.com · key ✓",
      "VM· llama-server · 10.0.0.5:8080",
      "MacBook· ollama · mbp.local:11434",
      "Item 4· ollama",
    ]);
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toContain("Item 1");
  });

  it("expands an entry on click into a two-column grid", async () => {
    await act(async () => {
      root.render(<JsonSchemaForm schema={schema} values={{ backends }} onChange={() => {}} />);
    });

    await act(async () => entryButtons()[1].click());

    expect(entryButtons().map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "true", "false", "false"]);
    const grid = container.querySelector(".sm\\:grid-cols-2");
    expect(grid).not.toBeNull();
    expect(grid!.querySelectorAll("input").length).toBeGreaterThanOrEqual(3);
    expect((grid!.querySelector('input[type="text"]') as HTMLInputElement).value).toBe("vm");

    await act(async () => entryButtons()[1].click());
    expect(container.querySelector("input")).toBeNull();
  });

  it("opens a newly added entry and keeps open state with the entries that shift up on remove", async () => {
    let values: Record<string, unknown> = { backends: backends.slice(0, 2) };
    const render = () =>
      root.render(
        <JsonSchemaForm
          schema={schema}
          values={values}
          onChange={(next) => {
            values = next;
            render();
          }}
        />,
      );
    await act(async () => render());

    const addButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Add item")!;
    await act(async () => addButton.click());
    expect(entryButtons().map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "false", "true"]);

    const removeFirst = container.querySelector<HTMLButtonElement>("button:has(> .sr-only)")!;
    expect(removeFirst.textContent).toBe("Remove LiteLLM proxy");
    await act(async () => removeFirst.click());
    expect((values.backends as unknown[]).length).toBe(2);
    expect(entryButtons().map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
  });

  it("starts an entry with nothing to summarize open", async () => {
    await act(async () => {
      root.render(
        <JsonSchemaForm schema={schema} values={{ backends: [backends[0], { id: "" }] }} onChange={() => {}} />,
      );
    });

    expect(entryButtons().map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
  });

  it("opens an entry that has a validation error", async () => {
    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={schema}
          values={{ backends }}
          errors={{ "/backends/2/id": "This field is required" }}
          onChange={() => {}}
        />,
      );
    });

    expect(entryButtons().map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "false", "true", "false"]);
    expect(container.textContent).toContain("This field is required");
  });

  it("keeps an error mark on an entry the user collapses", async () => {
    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={schema}
          values={{ backends }}
          errors={{ "/backends/2/id": "This field is required" }}
          onChange={() => {}}
        />,
      );
    });

    await act(async () => entryButtons()[2].click());

    expect(entryButtons()[2].getAttribute("aria-expanded")).toBe("false");
    expect(entryButtons()[2].textContent).toContain("1 error");
    expect(entryButtons()[0].textContent).not.toContain("error");
  });

  it("disables the fields of read-only entries", async () => {
    const readOnly: JsonSchemaNode = {
      ...schema,
      properties: { backends: { ...schema.properties!.backends, items: { ...schema.properties!.backends.items!, readOnly: true } } },
    };
    await act(async () => {
      root.render(<JsonSchemaForm schema={readOnly} values={{ backends: [{ id: "" }] }} onChange={() => {}} />);
    });

    const inputs = Array.from(container.querySelectorAll("input"));
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((input) => input.disabled)).toBe(true);
  });

  it("edits entries of an open-ended item schema as JSON", async () => {
    let values: Record<string, unknown> = { extras: [{ a: 1 }] };
    const openEnded: JsonSchemaNode = {
      type: "object",
      properties: { extras: { type: "array", items: { type: "object", additionalProperties: true } } },
    };
    const render = () =>
      root.render(
        <JsonSchemaForm
          schema={openEnded}
          values={values}
          onChange={(next) => {
            values = next;
            render();
          }}
        />,
      );
    await act(async () => render());

    // No declared properties means no summary, so the entry starts open.
    expect(entryButtons()[0].getAttribute("aria-expanded")).toBe("true");
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Item 1 JSON"]');
    expect(textarea).not.toBeNull();
    expect(container.textContent).not.toContain("No configuration options available");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, '{"b":2}');
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(values).toEqual({ extras: [{ b: 2 }] });
  });
});
