import { describe, expect, it } from "vitest";
import {
  isEnabledAdapterType,
  listAdapterOptions,
  listLocalAgentAdapterOptions,
  resolveDefaultLocalAgentAdapterType,
} from "./metadata";
import type { UIAdapterModule } from "./types";
import type { AdapterInfo } from "../api/adapters";

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
      },
    ]);
  });

  it("keeps intentionally withheld built-in adapters marked as coming soon", () => {
    expect(isEnabledAdapterType("process")).toBe(false);
    expect(isEnabledAdapterType("http")).toBe(false);
  });

  it("lists local agent adapter options from server metadata", () => {
    const adapters: AdapterInfo[] = [
      {
        type: "codex_local",
        label: "codex_local",
        source: "builtin",
        modelsCount: 0,
        loaded: true,
        disabled: false,
        supportsLocalAgentJwt: true,
      },
      {
        type: "process",
        label: "process",
        source: "builtin",
        modelsCount: 0,
        loaded: true,
        disabled: false,
        supportsLocalAgentJwt: false,
      },
      {
        type: "http",
        label: "http",
        source: "builtin",
        modelsCount: 0,
        loaded: true,
        disabled: false,
        supportsLocalAgentJwt: false,
      },
      {
        type: "external_local",
        label: "external_local",
        source: "external",
        modelsCount: 0,
        loaded: true,
        disabled: false,
        supportsLocalAgentJwt: true,
      },
      {
        type: "disabled_local",
        label: "disabled_local",
        source: "external",
        modelsCount: 0,
        loaded: true,
        disabled: true,
        supportsLocalAgentJwt: true,
      },
    ];

    expect(listLocalAgentAdapterOptions(undefined)).toEqual([]);
    expect(listLocalAgentAdapterOptions(adapters, (type) => type).map((option) => option.value))
      .toEqual(["codex_local", "external_local"]);
  });

  it("resolves local adapter defaults from CEO, then preferred fallbacks", () => {
    const options = [
      { value: "codex_local", label: "Codex", comingSoon: false, hidden: false },
      { value: "pi_local", label: "Pi", comingSoon: false, hidden: false },
      { value: "claude_local", label: "Claude", comingSoon: false, hidden: true },
    ];

    expect(resolveDefaultLocalAgentAdapterType(options, "pi_local")).toBe("pi_local");
    expect(resolveDefaultLocalAgentAdapterType([
      { value: "codex_local", comingSoon: false, hidden: false },
      { value: "claude_local", comingSoon: false, hidden: false },
    ], null)).toBe("claude_local");
    expect(resolveDefaultLocalAgentAdapterType(options, "missing_local")).toBe("codex_local");
    expect(resolveDefaultLocalAgentAdapterType([{ ...options[0]!, hidden: true }], null)).toBe("claude_local");
  });
});
