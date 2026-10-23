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
  nextAvailableEnvKey,
  parseAccessGrants,
  parseEnvSecretRefs,
  rowsToAccessMap,
  rowsToEnvMap,
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

  it("emits complete environment-secret rows without changing their env keys", () => {
    expect(
      rowsToEnvMap([
        { id: "1", name: "GH_TOKEN", secretId: "s1", version: 2 },
        { id: "2", name: "", secretId: "s1", version: "latest" },
        { id: "3", name: "NO_SECRET", secretId: "", version: "latest" },
        { id: "4", name: "1INVALID", secretId: "s2", version: "latest" },
        { id: "5", name: "GH_TOKEN", secretId: "s2", version: "latest" },
      ]),
    ).toEqual({ GH_TOKEN: { type: "secret_ref", secretId: "s1", version: 2 } });
  });

  it("derives valid unique env keys for selected secrets", () => {
    expect(nextAvailableEnvKey("123 token", [])).toBe("_123_TOKEN");
    expect(nextAvailableEnvKey("!!!", [])).toBe("SECRET");
    expect(nextAvailableEnvKey("github token", ["GITHUB_TOKEN", "GITHUB_TOKEN_2"]))
      .toBe("GITHUB_TOKEN_3");
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

  it("renders existing environment and API bindings on the Secrets tab", () => {
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
    expect(container.textContent).toContain("Env var");
    expect(container.textContent).toContain("API access");
    expect(container.textContent).toContain("env.GH_TOKEN");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Access alias"]')?.value).toBe("STRIPE");
    expect(container.querySelector('[aria-label="Remove environment secret"]')).toBeTruthy();
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

  it("adds and removes an environment-secret binding from the Secrets tab", () => {
    const emitted: Array<Record<string, EnvSecretRefBinding>> = [];
    render(
      <AgentSecretAccessEditor
        config={{}}
        secrets={secrets}
        onEnvChange={(next) => emitted.push(next)}
        onChange={() => {}}
      />,
    );

    const addButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Add environment secret"),
    )!;
    flushSync(() => addButton.click());

    const pickers = container.querySelectorAll<HTMLButtonElement>('[data-testid="pick-secret"]');
    flushSync(() => pickers[0]!.click());
    expect(emitted.at(-1)).toEqual({
      STRIPE_KEY: { type: "secret_ref", secretId: "s1", version: "latest" },
    });

    const removeButton = container.querySelector<HTMLButtonElement>('[aria-label="Remove environment secret"]')!;
    flushSync(() => removeButton.click());
    expect(emitted.at(-1)).toEqual({});
  });

  it("keeps the environment key when the secret behind it changes", () => {
    const emitted: Array<Record<string, EnvSecretRefBinding>> = [];
    render(
      <AgentSecretAccessEditor
        config={{ env: { GH_TOKEN: { type: "secret_ref", secretId: "s0", version: 1 } } }}
        secrets={secrets}
        onEnvChange={(next) => emitted.push(next)}
        onChange={() => {}}
      />,
    );
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="pick-secret"]')!.click());
    expect(emitted.at(-1)).toEqual({ GH_TOKEN: { type: "secret_ref", secretId: "s1", version: "latest" } });

    const nameInput = container.querySelector<HTMLInputElement>('input[aria-label="Environment variable name"]')!;
    expect(nameInput.value).toBe("GH_TOKEN");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(nameInput, "GITHUB_TOKEN");
    flushSync(() => nameInput.dispatchEvent(new Event("input", { bubbles: true })));
    expect(emitted.at(-1)).toEqual({ GITHUB_TOKEN: { type: "secret_ref", secretId: "s1", version: "latest" } });
  });

  it("keeps the saved assignment while a renamed key is invalid, duplicated or taken", () => {
    const emitted: Array<Record<string, EnvSecretRefBinding>> = [];
    render(
      <AgentSecretAccessEditor
        config={{
          env: {
            GH_TOKEN: { type: "secret_ref", secretId: "s0", version: 1 },
            STRIPE_KEY: { type: "secret_ref", secretId: "s1", version: "latest" },
            PLAIN: { type: "plain", value: "x" },
            USER_TOKEN: { type: "user_secret_ref", key: "personal-token" },
          },
        }}
        secrets={secrets}
        onEnvChange={(next) => emitted.push(next)}
        onChange={() => {}}
      />,
    );
    const nameInput = container.querySelector<HTMLInputElement>('input[aria-label="Environment variable name"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    for (const [name, message] of [
      ["GH-TOKEN", "Use letters, digits and _"],
      ["STRIPE_KEY", "Another environment secret uses this name"],
      ["PLAIN", "Already used by another environment variable"],
      ["USER_TOKEN", "Already used by another environment variable"],
    ] as const) {
      setter.call(nameInput, name);
      flushSync(() => nameInput.dispatchEvent(new Event("input", { bubbles: true })));
      expect(container.querySelector("[role=alert]")?.textContent).toContain(message);
    }
    // Every emit while the name is bad keeps the saved assignment.
    for (const map of emitted) {
      expect(map).toEqual({
        GH_TOKEN: { type: "secret_ref", secretId: "s0", version: 1 },
        STRIPE_KEY: { type: "secret_ref", secretId: "s1", version: "latest" },
      });
    }

    setter.call(nameInput, "GITHUB_TOKEN");
    flushSync(() => nameInput.dispatchEvent(new Event("input", { bubbles: true })));
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(emitted.at(-1)).toEqual({
      GITHUB_TOKEN: { type: "secret_ref", secretId: "s0", version: 1 },
      STRIPE_KEY: { type: "secret_ref", secretId: "s1", version: "latest" },
    });
  });

  it("saves edits to other rows while one renamed key is invalid", () => {
    const emitted: Array<Record<string, EnvSecretRefBinding>> = [];
    render(
      <AgentSecretAccessEditor
        config={{
          env: {
            GH_TOKEN: { type: "secret_ref", secretId: "s0", version: 1 },
            STRIPE_KEY: { type: "secret_ref", secretId: "s1", version: "latest" },
          },
        }}
        secrets={secrets}
        onEnvChange={(next) => emitted.push(next)}
        onChange={() => {}}
      />,
    );
    const nameInput = container.querySelector<HTMLInputElement>('input[aria-label="Environment variable name"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(nameInput, "GH-TOKEN");
    flushSync(() => nameInput.dispatchEvent(new Event("input", { bubbles: true })));
    // The invalid row keeps its saved assignment.
    expect(emitted.at(-1)).toEqual({
      GH_TOKEN: { type: "secret_ref", secretId: "s0", version: 1 },
      STRIPE_KEY: { type: "secret_ref", secretId: "s1", version: "latest" },
    });

    const removeButtons = container.querySelectorAll<HTMLButtonElement>('[aria-label="Remove environment secret"]');
    flushSync(() => removeButtons[1]!.click());
    expect(emitted.at(-1)).toEqual({ GH_TOKEN: { type: "secret_ref", secretId: "s0", version: 1 } });
  });

  it("keeps both assignments when a row takes the name an invalid row still holds", () => {
    const emitted: Array<Record<string, EnvSecretRefBinding>> = [];
    render(
      <AgentSecretAccessEditor
        config={{
          env: {
            A_TOKEN: { type: "secret_ref", secretId: "s0", version: 1 },
            B_TOKEN: { type: "secret_ref", secretId: "s1", version: "latest" },
          },
        }}
        secrets={secrets}
        onEnvChange={(next) => emitted.push(next)}
        onChange={() => {}}
      />,
    );
    const [first, second] = [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Environment variable name"]')];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(first!, "A-TOKEN");
    flushSync(() => first!.dispatchEvent(new Event("input", { bubbles: true })));
    setter.call(second!, "A_TOKEN");
    flushSync(() => second!.dispatchEvent(new Event("input", { bubbles: true })));

    expect(emitted.at(-1)).toEqual({
      A_TOKEN: { type: "secret_ref", secretId: "s0", version: 1 },
      B_TOKEN: { type: "secret_ref", secretId: "s1", version: "latest" },
    });
    const alerts = [...container.querySelectorAll("[role=alert]")].map((node) => node.textContent);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toContain("Another environment secret uses this name");
  });

  it("shows user-secret environment bindings and edits their requirement", () => {
    const emitted: Array<Record<string, unknown>> = [];
    render(
      <AgentSecretAccessEditor
        config={{ env: {
          OPENAI_API_KEY: { type: "user_secret_ref", key: "OPENAI_API_KEY", version: "latest", required: true },
          GH_TOKEN: { type: "secret_ref", secretId: "s1" },
          PLAIN: { type: "plain", value: "hi" },
        } }}
        secrets={secrets}
        onChange={() => {}}
        onUserSecretEnvChange={(next) => emitted.push(next)}
      />,
    );
    expect(container.textContent).toContain("User secrets");
    expect(container.textContent).toContain("env.OPENAI_API_KEY");
    const requirement = container.querySelector<HTMLSelectElement>('select[aria-label="Requirement for OPENAI_API_KEY"]')!;
    expect(requirement.value).toBe("required");
    const selectSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
    selectSetter.call(requirement, "optional");
    flushSync(() => requirement.dispatchEvent(new Event("change", { bubbles: true })));
    expect(emitted.at(-1)).toEqual({
      OPENAI_API_KEY: { type: "user_secret_ref", key: "OPENAI_API_KEY", version: "latest", required: false },
    });
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove user secret OPENAI_API_KEY"]')!.click());
    expect(emitted.at(-1)).toEqual({});
  });

  it("only assigns existing secrets and never asks for a value again", () => {
    render(
      <AgentSecretAccessEditor
        config={{ "access.STRIPE": { type: "secret_ref", secretId: "s1" } }}
        secrets={secrets}
        onChange={() => {}}
      />,
    );

    expect(container.querySelector('[data-testid="create-secret"]')).toBeNull();
    expect(mockSecretPickerRender).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ onCreateNew: expect.any(Function) }),
    );
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
});
