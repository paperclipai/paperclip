// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret, EnvSecretRefBinding } from "@paperclipai/shared";

// Stub SecretBindingPicker so the editor renders without CompanyContext /
// react-query. The stub exposes a button that binds a fixed secret.
vi.mock("./SecretBindingPicker", () => ({
  SecretBindingPicker: ({
    onChange,
  }: {
    onChange: (next: { secretId: string; version?: number | "latest" } | null) => void;
  }) => (
    <button type="button" data-testid="pick-secret" onClick={() => onChange({ secretId: "s1", version: "latest" })}>
      pick
    </button>
  ),
}));

import {
  AgentSecretAccessEditor,
  parseAccessGrants,
  parseEnvSecretRefs,
  rowsToAccessMap,
  summarizeAgentBindings,
} from "./AgentSecretAccessEditor";

function makeSecret(id: string, name: string): CompanySecret {
  return {
    id,
    companyId: "co",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: id,
    name,
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("AgentSecretAccessEditor model", () => {
  const config = {
    env: {
      GH_TOKEN: { type: "secret_ref", secretId: "s1", version: 2 },
      PLAIN: { type: "plain", value: "hi" },
    },
    "access.STRIPE": { type: "secret_ref", secretId: "s1" },
    "access.BROKEN": { type: "plain", value: "nope" },
    model: "claude",
  };

  it("parses env secret refs, ignoring plain values", () => {
    expect(parseEnvSecretRefs(config)).toEqual([{ name: "GH_TOKEN", secretId: "s1", version: 2 }]);
  });

  it("parses only well-formed top-level access.* secret refs", () => {
    expect(parseAccessGrants(config)).toEqual([{ name: "STRIPE", secretId: "s1", version: "latest" }]);
  });

  it("summarizes bindings per secret with both delivery modes", () => {
    const summary = summarizeAgentBindings(parseEnvSecretRefs(config), parseAccessGrants(config));
    expect(summary).toEqual([{ secretId: "s1", envKeys: ["GH_TOKEN"], apiAliases: ["STRIPE"] }]);
  });

  it("drops incomplete, invalid-alias, and unselected rows from the emitted access map", () => {
    expect(
      rowsToAccessMap([
        { id: "1", alias: "OK", secretId: "s1", version: "latest" },
        { id: "2", alias: "", secretId: "s1", version: "latest" }, // no alias
        { id: "3", alias: "1BAD", secretId: "s1", version: "latest" }, // invalid alias
        { id: "4", alias: "NOSECRET", secretId: "", version: "latest" }, // no secret
      ]),
    ).toEqual({ OK: { type: "secret_ref", secretId: "s1", version: "latest" } });
  });
});

describe("AgentSecretAccessEditor component", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  function render(node: React.ReactNode) {
    root = createRoot(container);
    flushSync(() => root!.render(node));
  }

  const secrets = [makeSecret("s1", "STRIPE_KEY")];

  it("shows the delivery-mode overview for existing bindings", () => {
    render(
      <AgentSecretAccessEditor
        config={{
          env: { GH_TOKEN: { type: "secret_ref", secretId: "s1" } },
          "access.STRIPE": { type: "secret_ref", secretId: "s1" },
        }}
        secrets={secrets}
        onChange={() => {}}
      />,
    );
    expect(container.textContent).toContain("STRIPE_KEY");
    expect(container.textContent).toContain("Env var");
    expect(container.textContent).toContain("API access");
    expect(container.textContent).toContain("env.GH_TOKEN");
    expect(container.textContent).toContain("access.STRIPE");
  });

  it("adds an API-access grant, emitting an access.<ALIAS> secret_ref", () => {
    const emitted: Array<Record<string, EnvSecretRefBinding>> = [];
    render(
      <AgentSecretAccessEditor
        config={{}}
        secrets={secrets}
        onChange={(next) => emitted.push(next)}
      />,
    );

    // "Add API access" appends an editable row.
    const addButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Add API access"),
    )!;
    flushSync(() => addButton.click());

    // Type an alias.
    const aliasInput = container.querySelector<HTMLInputElement>('input[aria-label="Access alias"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(aliasInput, "STRIPE");
    flushSync(() => aliasInput.dispatchEvent(new Event("input", { bubbles: true })));

    // Bind a secret via the stubbed picker.
    const pick = container.querySelector<HTMLButtonElement>('[data-testid="pick-secret"]')!;
    flushSync(() => pick.click());

    const last = emitted.at(-1)!;
    expect(last).toEqual({ STRIPE: { type: "secret_ref", secretId: "s1", version: "latest" } });
  });
});
