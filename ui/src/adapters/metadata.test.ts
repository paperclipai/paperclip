import { describe, expect, it } from "vitest";
import {
  isEnabledAdapterType,
  isValidAdapterType,
  isVisualAdapterChoice,
  listAdapterOptions,
} from "./metadata";
import type { UIAdapterModule } from "./types";

const externalAdapter: UIAdapterModule = {
  type: "external_test",
  label: "External Test",
  parseStdoutLine: () => [],
  ConfigFields: () => null,
  buildAdapterConfig: () => ({}),
};

describe("adapter metadata", () => {
  it("treats registered external adapters as enabled by default", () => {
    expect(isEnabledAdapterType("external_test")).toBe(true);

    expect(
      listAdapterOptions((type) => type, [externalAdapter]),
    ).toEqual([
      {
        value: "external_test",
        label: "external_test",
        comingSoon: false,
        hidden: false,
        experimental: false,
      },
    ]);
  });

  it("keeps intentionally withheld built-in adapters marked as coming soon", () => {
    expect(isEnabledAdapterType("process")).toBe(false);
    expect(isEnabledAdapterType("http")).toBe(false);
  });

  it("marks the retired ACPX adapter as unavailable for new selections", () => {
    expect(isEnabledAdapterType("acpx_local")).toBe(false);
    expect(isValidAdapterType("acpx_local")).toBe(false);
    expect(isVisualAdapterChoice("acpx_local")).toBe(false);

    expect(
      listAdapterOptions((type) => type, [
        {
          ...externalAdapter,
          type: "acpx_local",
        },
      ]),
    ).toEqual([
      {
        value: "acpx_local",
        label: "acpx_local",
        comingSoon: true,
        hidden: false,
        experimental: false,
      },
    ]);
  });

  it("shows openai_compatible as an available built-in adapter", () => {
    expect(isEnabledAdapterType("openai_compatible")).toBe(true);
    expect(isValidAdapterType("openai_compatible")).toBe(true);
    expect(isVisualAdapterChoice("openai_compatible")).toBe(true);

    expect(
      listAdapterOptions((type) => type, [
        {
          ...externalAdapter,
          type: "openai_compatible",
        },
      ]),
    ).toEqual([
      {
        value: "openai_compatible",
        label: "openai_compatible",
        comingSoon: false,
        hidden: false,
        experimental: false,
      },
    ]);
  });
});
