// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret, EnvSecretRefBinding } from "@paperclipai/shared";

const mockSecretPickerRender = vi.hoisted(() => vi.fn());

// Keep this component test focused on access-row behavior while asserting that
// the editor routes selection through the shared, folder-aware env picker.
vi.mock("./environment-variables-editor/SecretPicker", () => ({
  SecretPicker: (props: {
    secretId: string;
    secrets: readonly CompanySecret[];
    onSelect: (secretId: string) => void;
    onCreateNew?: (query: string) => void;
  }) => {
    mockSecretPickerRender(props);
    return <>
      <button type="button" data-testid="pick-secret" onClick={() => props.onSelect("s1")}>
        pick
      </button>
      {props.onCreateNew ? (
        <button type="button" data-testid="create-secret" onClick={() => props.onCreateNew?.("new_secret")}>
          create
        </button>
      ) : null}
    </>;
  },
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
    expect(mockSecretPickerRender).toHaveBeenLastCalledWith(
      expect.objectContaining({ secretId: "", secrets }),
    );
    flushSync(() => pick.click());

    const last = emitted.at(-1)!;
    expect(last).toEqual({ STRIPE: { type: "secret_ref", secretId: "s1", version: "latest" } });
  });

  it("keeps the create form open when focus returns to the shared picker anchor", async () => {
    vi.useFakeTimers();
    try {
      render(
        <AgentSecretAccessEditor
          config={{ "access.STRIPE": { type: "secret_ref", secretId: "s1" } }}
          secrets={secrets}
          onChange={() => {}}
          onCreateSecret={async () => secrets[0]!}
        />,
      );

      const createButton = container.querySelector<HTMLButtonElement>('[data-testid="create-secret"]')!;
      flushSync(() => createButton.click());
      flushSync(() => vi.runAllTimers());
      expect(document.body.textContent).toContain("Create secret");

      const pickerButton = container.querySelector<HTMLButtonElement>('[data-testid="pick-secret"]')!;
      pickerButton.focus();
      flushSync(() => {});

      expect(document.body.textContent).toContain("Create secret");
      expect(document.querySelector('input[aria-label="Secret name"]')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders pending binding proposals as Proposed rows with approve/reject", () => {
    const approved: string[] = [];
    const rejected: string[] = [];
    const proposal = {
      id: "prop-1",
      companyId: "co",
      kind: "binding" as const,
      status: "pending" as const,
      justification: "Bind Stripe for the billing agent.",
      proposedName: null,
      proposedKey: null,
      proposedDescription: null,
      valueFingerprintSha256: null,
      valueLength: null,
      secretId: "s1",
      secretName: "STRIPE_KEY",
      secretProposalId: null,
      secretProposalName: null,
      targetType: "agent" as const,
      target: { id: "agent-1", name: "BillingBot", icon: null },
      configPath: "access.STRIPE",
      proposedBy: { id: "agent-2", name: "ClaudeCoder", icon: null },
      originIssue: null,
      originRunId: "run-1",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: new Date(0).toISOString(),
      resolvedByUserId: null,
      resolvedAt: null,
      resolutionReason: null,
      createdSecretId: null,
      appliedBindingConfigPath: null,
      viewerCanApprove: true,
      approveBlockReason: null,
    };
    render(
      <AgentSecretAccessEditor
        config={{}}
        secrets={secrets}
        onChange={() => {}}
        proposals={[proposal]}
        onApproveProposal={(p) => approved.push(p.id)}
        onRejectProposal={(p) => rejected.push(p.id)}
      />,
    );

    expect(container.textContent).toContain("Proposed access");
    expect(container.textContent).toContain("STRIPE"); // alias + bound secret name
    expect(container.textContent).toContain("ClaudeCoder"); // proposer

    const approveButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Approve",
    )!;
    flushSync(() => approveButton.click());
    expect(approved).toEqual(["prop-1"]);

    const rejectButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Reject",
    )!;
    flushSync(() => rejectButton.click());
    expect(rejected).toEqual(["prop-1"]);
  });

  it("explains that API-access secrets are not exposed as $NAME env vars and offers a quick bind-as-env-var action", () => {
    const boundEnv: Array<{ envKey: string; secretId: string; version: number | "latest" }> = [];
    render(
      <AgentSecretAccessEditor
        config={{
          "access.STRIPE_KEY": { type: "secret_ref", secretId: "s1", version: "latest" },
        }}
        secrets={secrets}
        onChange={() => {}}
        onBindAsEnvVar={(binding) => boundEnv.push(binding)}
      />,
    );

    // Clarifies that processes/scripts will not see $NAME unless bound under Environment variables.
    expect(container.textContent).toMatch(/\$NAME|\$STRIPE_KEY/);
    expect(container.textContent?.toLowerCase()).toContain("environment variables");

    const bindEnvButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Also bind as env var"),
    );
    expect(bindEnvButton, "Also bind as env var action should render for API-only binding").toBeTruthy();
    flushSync(() => bindEnvButton!.click());
    expect(boundEnv).toEqual([{ envKey: "STRIPE_KEY", secretId: "s1", version: "latest" }]);
  });

  it("asks before replacing an occupied env var name on Also bind as env var", () => {
    const boundEnv: Array<{ envKey: string; secretId: string; version: number | "latest"; replaceExisting?: boolean }> = [];
    render(
      <AgentSecretAccessEditor
        config={{
          env: {
            STRIPE_KEY: { type: "plain", value: "existing-plain" },
          },
          "access.STRIPE_KEY": { type: "secret_ref", secretId: "s1", version: "latest" },
        }}
        secrets={secrets}
        onChange={() => {}}
        onBindAsEnvVar={(binding) => boundEnv.push(binding)}
      />,
    );

    const bindEnvButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Also bind as env var"),
    )!;
    flushSync(() => bindEnvButton.click());
    // Must not silently overwrite the occupied env var.
    expect(boundEnv).toEqual([]);
    expect(container.textContent).toContain("$STRIPE_KEY already exists");

    // Option 1: pick the unused fallback name.
    const fallbackButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Bind as STRIPE_KEY_2"),
    )!;
    flushSync(() => fallbackButton.click());
    expect(boundEnv).toEqual([{ envKey: "STRIPE_KEY_2", secretId: "s1", version: "latest" }]);

    // Option 2: explicitly confirm replacing the occupied name.
    flushSync(() => bindEnvButton.click());
    const replaceButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Replace STRIPE_KEY"),
    )!;
    flushSync(() => replaceButton.click());
    expect(boundEnv.at(-1)).toEqual({
      envKey: "STRIPE_KEY",
      secretId: "s1",
      version: "latest",
      replaceExisting: true,
    });
  });

  it("copies the chosen free alias's pinned version when multiple aliases reference the same secret", () => {
    const boundEnv: Array<{ envKey: string; secretId: string; version: number | "latest" }> = [];
    render(
      <AgentSecretAccessEditor
        config={{
          env: {
            OLD: { type: "plain", value: "occupied" },
          },
          "access.OLD": { type: "secret_ref", secretId: "s1", version: 1 },
          "access.NEW": { type: "secret_ref", secretId: "s1", version: 3 },
        }}
        secrets={secrets}
        onChange={() => {}}
        onBindAsEnvVar={(binding) => boundEnv.push(binding)}
      />,
    );

    const bindEnvButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Also bind as env var"),
    )!;
    flushSync(() => bindEnvButton.click());
    expect(boundEnv).toEqual([{ envKey: "NEW", secretId: "s1", version: 3 }]);
  });

  it("scales linearly when rendering and editing an alias across 200 secrets and bindings", () => {
    const count = 200;
    let secretIdReads = 0;
    const maxReads = count * 20;
    const largeSecrets = Array.from({ length: count }, (_, index) => {
      const secret = makeSecret(`s-${index}`, `SECRET_${index}`);
      let idValue = secret.id;
      Object.defineProperty(secret, "id", {
        enumerable: true,
        get() {
          secretIdReads += 1;
          if (secretIdReads > maxReads) {
            throw new Error(`Quadratic secret lookup detected (${secretIdReads} reads for ${count} secrets)`);
          }
          return idValue;
        },
        set(next: string) {
          idValue = next;
        },
      });
      return secret;
    });
    const largeConfig: Record<string, unknown> = {};
    for (let index = 0; index < count; index += 1) {
      largeConfig[`access.ALIAS_${index}`] = { type: "secret_ref", secretId: `s-${index}`, version: "latest" };
    }

    render(
      <AgentSecretAccessEditor
        config={largeConfig}
        secrets={largeSecrets}
        onChange={() => {}}
        onBindAsEnvVar={() => {}}
      />,
    );
    const readsAfterMount = secretIdReads;
    expect(readsAfterMount).toBeLessThanOrEqual(count * 4);

    // Typing into one alias input must not rescan secrets per row/summary.
    const aliasInput = container.querySelector<HTMLInputElement>('input[aria-label="Access alias"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(aliasInput, "ALIAS_0_EDITED");
    flushSync(() => aliasInput.dispatchEvent(new Event("input", { bubbles: true })));
    expect(secretIdReads - readsAfterMount).toBeLessThanOrEqual(count * 2);
  });
});
