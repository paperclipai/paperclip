import { describe, expect, it } from "vitest";
import type { AdapterConfigSchema, ConfigFieldSchema } from "@paperclipai/adapter-utils";
import { fieldMatchesVisibleWhen, resolveComboboxTypedValue } from "./schema-config-fields";

const sourceField: ConfigFieldSchema = {
  key: "provider",
  label: "Provider",
  type: "select",
  options: [
    { label: "Claude", value: "claude" },
    { label: "Codex", value: "codex" },
  ],
};

const schema: AdapterConfigSchema = {
  fields: [sourceField],
};

function targetWithVisibleWhen(visibleWhen: Record<string, unknown>): ConfigFieldSchema {
  return {
    key: "model",
    label: "Model",
    type: "text",
    meta: { visibleWhen },
  };
}

describe("fieldMatchesVisibleWhen", () => {
  it("treats an empty values array as no match", () => {
    const field = targetWithVisibleWhen({ key: "provider", values: [] });

    expect(fieldMatchesVisibleWhen(field, () => "claude", schema)).toBe(false);
  });

  it("treats all non-string values as no match", () => {
    const field = targetWithVisibleWhen({ key: "provider", values: [null, 42] });

    expect(fieldMatchesVisibleWhen(field, () => "claude", schema)).toBe(false);
  });

  it("matches non-empty string values", () => {
    const field = targetWithVisibleWhen({ key: "provider", values: ["claude"] });

    expect(fieldMatchesVisibleWhen(field, () => "claude", schema)).toBe(true);
    expect(fieldMatchesVisibleWhen(field, () => "codex", schema)).toBe(false);
  });
});

describe("resolveComboboxTypedValue", () => {
  const providerOptions = [
    { label: "Auto", value: "auto" },
    { label: "Openrouter", value: "openrouter" },
    { label: "Minimax", value: "minimax" },
    { label: "MiniMax China", value: "minimax-cn" },
  ];

  it("keeps the current value when nothing was typed", () => {
    expect(resolveComboboxTypedValue("", providerOptions)).toBeNull();
  });

  it("commits typed text that matches no option", () => {
    expect(resolveComboboxTypedValue("custom:spark-local", providerOptions)).toBe("custom:spark-local");
  });

  it("commits the only matching option, as Enter does", () => {
    expect(resolveComboboxTypedValue("openr", providerOptions)).toBe("openrouter");
  });

  it("commits the typed text when several options match", () => {
    expect(resolveComboboxTypedValue("minimax", providerOptions)).toBe("minimax");
  });
});
