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

  it("keeps the OpenClaw Gateway adapter enabled", () => {
    expect(isEnabledAdapterType("openclaw_gateway")).toBe(true);
    expect(isValidAdapterType("openclaw_gateway")).toBe(true);
  });

  it("keeps the Ollama HTTP adapter enabled", () => {
    expect(isEnabledAdapterType("ollama_http")).toBe(true);
    expect(isValidAdapterType("ollama_http")).toBe(true);
  });

  it("keeps the Cloudflare Workers AI adapter enabled", () => {
    expect(isEnabledAdapterType("cloudflare_workers_ai")).toBe(true);
    expect(isValidAdapterType("cloudflare_workers_ai")).toBe(true);
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
