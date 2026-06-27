// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AdapterConfigFieldsProps } from "./types";

vi.mock("../components/agent-config-primitives", () => ({
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <label>
      {label}
      {children}
    </label>
  ),
  help: {
    runtimeServicesJson: "Runtime services JSON",
    payloadTemplateJson: "Payload template JSON",
  },
}));

import { PayloadTemplateJsonField, RuntimeServicesJsonField } from "./runtime-json-fields";

const props = {
  isCreate: false,
  adapterType: "test",
  values: null,
  set: null,
  config: {},
  eff: vi.fn(),
  mark: vi.fn(),
  models: [],
  mode: "edit",
} satisfies AdapterConfigFieldsProps;

describe("runtime JSON adapter fields", () => {
  it("renders the payload template label without a module-scope t binding", () => {
    expect(() => renderToStaticMarkup(createElement(PayloadTemplateJsonField, props))).not.toThrow();
  });

  it("keeps disabled runtime services field safe to render", () => {
    expect(() => renderToStaticMarkup(createElement(RuntimeServicesJsonField, props))).not.toThrow();
  });
});
