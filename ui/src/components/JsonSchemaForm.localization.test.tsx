// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "@/i18n";
import { JsonSchemaForm, jsonSchemaErrorDisplay, validateField, validateJsonSchemaForm, type JsonSchemaNode } from "./JsonSchemaForm";

vi.mock("./SecretBindingPicker", () => ({
  SecretBindingPicker: ({ placeholder, emptyHint, value }: { placeholder: string; emptyHint: string; value: unknown }) => (
    <div data-testid="secret-picker" data-binding={JSON.stringify(value)}><span>{placeholder}</span><span>{emptyHint}</span></div>
  ),
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!globalThis.PointerEvent) globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
}
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  await i18n.changeLanguage("en");
});
async function mount(schema: JsonSchemaNode, values: Record<string, unknown>, onChange = vi.fn(), errors?: Record<string, string>, advancedLabel?: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<JsonSchemaForm schema={schema} values={values} onChange={onChange} errors={errors} advancedLabel={advancedLabel} />));
  return onChange;
}
async function locale(language: "en" | "ru") {
  await act(async () => { await i18n.changeLanguage(language); });
}

describe("JSON Schema validation display", () => {
  it.each<[unknown, JsonSchemaNode, boolean, string, string]>([
    [undefined, { type: "string" }, true, "This field is required", "Обязательное поле"],
    [{ secretId: "raw-id" }, { format: "secret-ref" }, false, "Invalid secret reference", "Некорректная ссылка на секрет"],
    ["a", { type: "string", minLength: 2 }, false, "Must be at least 2 characters", "Минимальная длина — 2 символа"],
    ["long", { type: "string", maxLength: 1 }, false, "Must be at most 1 characters", "Максимальная длина — 1 символ"],
    ["abc", { type: "string", pattern: "^[A-Z]{2,5}$" }, false, "Must match pattern: ^[A-Z]{2,5}$", "Значение должно соответствовать шаблону: ^[A-Z]{2,5}$"],
    ["no", { type: "number" }, false, "Must be a valid number", "Введите число"],
    [0, { type: "number", minimum: 1.5 }, false, "Must be at least 1.5", "Не меньше 1,5"],
    [2, { type: "number", maximum: 1.5 }, false, "Must be at most 1.5", "Не больше 1,5"],
    [1.5, { type: "number", exclusiveMinimum: 1.5 }, false, "Must be greater than 1.5", "Больше 1,5"],
    [1.5, { type: "number", exclusiveMaximum: 1.5 }, false, "Must be less than 1.5", "Меньше 1,5"],
    [1.5, { type: "integer" }, false, "Must be a whole number", "Введите целое число"],
    [1, { type: "number", multipleOf: 0.3 }, false, "Must be a multiple of 0.3", "Число должно быть кратно 0,3"],
    [[], { type: "array", minItems: 2 }, false, "Must have at least 2 items", "Минимальное количество — 2 элемента"],
    [[1, 2], { type: "array", maxItems: 1 }, false, "Must have at most 1 items", "Максимальное количество — 1 элемент"],
  ])("keeps canonical error %s and translates only its display", async (value, schema, required, english, russian) => {
    const before = JSON.stringify({ value, schema });
    expect(validateField(value, schema, required)).toBe(english);
    expect(jsonSchemaErrorDisplay(english, schema)).toBe(english);
    await locale("ru");
    expect(validateField(value, schema, required)).toBe(english);
    expect(jsonSchemaErrorDisplay(english, schema)).toBe(russian);
    expect(JSON.stringify({ value, schema })).toBe(before);
  });

  it.each([
    [1, "1 символ", "1 элемент"], [2, "2 символа", "2 элемента"], [5, "5 символов", "5 элементов"],
    [21, "21 символ", "21 элемент"], [22, "22 символа", "22 элемента"], [25, "25 символов", "25 элементов"],
    [1.5, "1,5 символа", "1,5 элемента"],
  ])("uses Russian length and item count forms for %s", async (count, characters, items) => {
    await locale("ru");
    expect(jsonSchemaErrorDisplay(`Must be at least ${count} characters`, { minLength: count })).toBe(`Минимальная длина — ${characters}`);
    expect(jsonSchemaErrorDisplay(`Must be at most ${count} characters`, { maxLength: count })).toBe(`Максимальная длина — ${characters}`);
    expect(jsonSchemaErrorDisplay(`Must have at least ${count} items`, { minItems: count })).toBe(`Минимальное количество — ${items}`);
    expect(jsonSchemaErrorDisplay(`Must have at most ${count} items`, { maxItems: count })).toBe(`Максимальное количество — ${items}`);
  });

  it("does not round numeric constraints or rewrite unknown errors and patterns", async () => {
    await locale("ru");
    expect(jsonSchemaErrorDisplay("Must be at least 0.00000123", { minimum: 0.00000123 })).toBe("Не меньше 0,00000123");
    expect(jsonSchemaErrorDisplay("Must be a multiple of 1e-12", { multipleOf: 1e-12 })).toBe("Число должно быть кратно 0,000000000001");
    expect(jsonSchemaErrorDisplay("Custom error: secret_ref /auth/key", {})).toBe("Custom error: secret_ref /auth/key");
    expect(jsonSchemaErrorDisplay("Must be at least 8", { minimum: 3 })).toBe("Must be at least 8");
    expect(jsonSchemaErrorDisplay("Must match pattern: RAW", { pattern: "OTHER" })).toBe("Must match pattern: RAW");
  });

  it("preserves recursive JSON pointers, canonical errors, and valid secret references", async () => {
    const schema: JsonSchemaNode = { type: "object", properties: {
      nested: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      rows: { type: "array", items: { type: "number", minimum: 2 } },
      secret: { format: "secret-ref" },
    } };
    const values = { nested: {}, rows: [1, 2], secret: { type: "secret_ref", secretId: "raw-secret-id", version: "latest" } };
    const expected = { "/nested/name": "This field is required", "/rows/0": "Must be at least 2" };
    const before = JSON.stringify({ schema, values });
    expect(validateJsonSchemaForm(schema, values)).toEqual(expected);
    await locale("ru");
    expect(validateJsonSchemaForm(schema, values)).toEqual(expected);
    expect(JSON.stringify({ schema, values })).toBe(before);
  });
});

describe("Mounted JSON Schema localization", () => {
  it("updates existing errors without clearing drafts, changing error paths, or reopening a collapsed group", async () => {
    const schema: JsonSchemaNode = { type: "object", required: ["name"], properties: {
      name: { type: "string", title: "External title", description: "External description" },
      settings: { type: "object", properties: { count: { type: "number", minimum: 1.25 } } },
      draft: { type: "string", "x-paperclip-advanced": true },
      items: { type: "array", items: { type: "string" }, minItems: 2 },
      custom: { type: "string" },
    } };
    const values = { name: "", settings: { count: 0.5 }, draft: "RAW_USER_DRAFT", items: ["RAW_ITEM"], custom: "raw" };
    const errors = { ...validateJsonSchemaForm(schema, values), "/custom": "External validation /custom", "/draft": "External draft error" };
    const before = JSON.stringify({ schema, values, errors });
    const onChange = await mount(schema, values, vi.fn(), errors);
    const advanced = Array.from(container!.querySelectorAll("button")).find(b => b.textContent === "Advanced options")!;
    expect(advanced.getAttribute("aria-expanded")).toBe("true");
    expect(container?.textContent).toContain("More options");
    await locale("ru");
    expect(container?.textContent).toContain("Обязательное поле");
    expect(container?.textContent).toContain("Не меньше 1,25");
    expect(container?.textContent).toContain("Минимальное количество — 2 элемента");
    expect(container?.textContent).toContain("Другие параметры");
    expect(container?.textContent).toContain("External title");
    expect(container?.textContent).toContain("External description");
    expect(container?.textContent).toContain("External validation /custom");
    expect(container?.textContent).toContain("Элемент 1");
    expect(Array.from(container!.querySelectorAll("input")).some(input => input.value === "RAW_USER_DRAFT")).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => advanced.click());
    await locale("en");
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    expect(container?.textContent).toContain("This field is required");
    expect(onChange).not.toHaveBeenCalled();
    expect(JSON.stringify({ schema, values, errors })).toBe(before);
  });

  it("changes secret chrome without revealing hidden content or resetting a user-selected reveal mode", async () => {
    const values = { key: "RAW_TEST_SECRET\nSECOND_LINE" };
    const onChange = await mount({ type: "object", properties: { key: { type: "string", format: "secret-ref", maxLength: 4096 } } }, values);
    expect(container?.querySelector("textarea")?.value).not.toContain("RAW_TEST_SECRET");
    await locale("ru");
    expect(container?.textContent).toContain("Выберите существующий секрет");
    expect(container?.querySelector("textarea")?.value).toContain("Конфиденциальные данные");
    expect(container?.querySelector("textarea")?.value).not.toContain("RAW_TEST_SECRET");
    const reveal = Array.from(container!.querySelectorAll("button")).find(b => b.textContent?.trim() === "Показать секрет")!;
    await act(async () => reveal.click());
    expect(container?.querySelector("textarea")?.value).toBe(values.key);
    await locale("en");
    expect(container?.querySelector("textarea")?.value).toBe(values.key);
    expect(reveal.textContent?.trim()).toBe("Hide secret");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps custom advanced titles, group headings, defaults and numeric suggestions raw", async () => {
    const onChange = await mount({ type: "object", properties: {
      port: { type: "integer", default: 22, examples: [22, 2222], "x-paperclip-advanced": true, "x-paperclip-group": "More options" },
      note: { type: "string", "x-paperclip-advanced": true, "x-paperclip-group": "Custom group" },
    } }, { port: 22, note: "USER_DRAFT" }, vi.fn(), {}, "Custom advanced title");
    const advanced = Array.from(container!.querySelectorAll("button")).find(b => b.textContent === "Custom advanced title")!;
    await act(async () => advanced.click());
    await locale("ru");
    expect(advanced.textContent).toBe("Custom advanced title");
    expect(container?.textContent).toContain("More options");
    expect(container?.textContent).toContain("Custom group");
    expect(container?.textContent).not.toContain("Другие параметры");
    expect(container?.querySelector('input[type="number"]')?.getAttribute("placeholder")).toBe("22");
    expect(Array.from(container!.querySelectorAll("datalist option")).map(option => option.getAttribute("value"))).toEqual(["22", "2222"]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("translates optional enum chrome while retaining raw numeric enum values and callbacks", async () => {
    const onChange = await mount({ type: "object", properties: { memory: { type: "integer", enum: [1, 2, 4] } } }, {});
    const trigger = container!.querySelector<HTMLElement>('[role="combobox"]')!;
    await locale("ru");
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    expect(options.map(o => o.textContent?.trim())).toEqual(["Не задано", "1", "2", "4"]);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => options.find(o => o.textContent?.trim() === "2")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ memory: 2 });
  });

  it.each([[1, "скрыт 1 символ"], [2, "скрыто 2 символа"], [5, "скрыто 5 символов"], [21, "скрыт 21 символ"], [22, "скрыто 22 символа"], [25, "скрыто 25 символов"]])("pluralizes hidden secret lengths for %i", async (count, expected) => {
    await locale("ru");
    expect(t("localizationSchemaForm.hiddenSecret", { count })).toContain(expected);
  });
});
