import { describe, expect, it } from "vitest";
import { getAdapterDisplay } from "./adapter-display-registry";
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
  });

  it("enables the built-in HTTP adapter for remote webhook agents", () => {
    expect(isEnabledAdapterType("http")).toBe(true);
    expect(isValidAdapterType("http")).toBe(true);
    expect(isVisualAdapterChoice("http")).toBe(true);
    expect(getAdapterDisplay("http")).toMatchObject({
      label: "HTTP Webhook",
      description: "Remote HTTP webhook adapter (bridges, external services)",
    });
    expect(getAdapterDisplay("http").comingSoon).toBeUndefined();
  });

  it("keeps ACPX selectable from explicit configuration but out of visual pickers", () => {
    expect(isEnabledAdapterType("acpx_local")).toBe(true);
    expect(isValidAdapterType("acpx_local")).toBe(true);
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
        comingSoon: false,
        hidden: false,
        experimental: true,
      },
    ]);
  });
});
