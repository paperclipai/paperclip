// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { CompanySecret, EnvBinding, UserSecretDefinition } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentVariablesEditor } from "./environment-variables-editor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const definition: UserSecretDefinition = {
  id: "def-1",
  companyId: "c1",
  key: "PERSONAL_GH_TOKEN",
  name: "Personal GitHub token",
  description: null,
  status: "active",
  provider: "local_encrypted",
  managedMode: "paperclip_managed",
  providerConfigId: null,
  providerMetadata: null,
  usageGuidance: null,
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: Partial<React.ComponentProps<typeof EnvironmentVariablesEditor>>) {
  root = createRoot(container);
  return act(() => {
    root.render(
      <EnvironmentVariablesEditor
        value={props.value ?? {}}
        secrets={props.secrets ?? []}
        userSecretDefinitions={props.userSecretDefinitions}
        onCreateSecret={props.onCreateSecret ?? (vi.fn() as never)}
        onChange={props.onChange ?? vi.fn()}
      />,
    );
  });
}

describe("EnvironmentVariablesEditor user secret binding", () => {
  it("renders an existing user_secret_ref as a User secret row with the definition and requirement", async () => {
    const value: Record<string, EnvBinding> = {
      GH_TOKEN: { type: "user_secret_ref", key: "PERSONAL_GH_TOKEN", required: true },
    };
    await render({ value, userSecretDefinitions: [definition] });

    const keyInput = container.querySelector<HTMLInputElement>('input[placeholder="KEY"]');
    expect(keyInput?.value).toBe("GH_TOKEN");
    // Radix Select triggers render the selected label as text.
    expect(container.textContent).toContain("User secret");
    expect(container.textContent).toContain("Personal GitHub token");
    expect(container.textContent).toContain("Required");
  });

  it("explains user-secret bindings when a user secret row is present", async () => {
    await render({
      value: { GH_TOKEN: { type: "user_secret_ref", key: "PERSONAL_GH_TOKEN", required: true } },
      userSecretDefinitions: [definition],
    });
    expect(container.textContent).toContain("Personal GitHub token");
    expect(container.textContent).toContain("User secrets resolve from the user responsible for the run.");
  });

  it("keeps working for company secrets when no user definitions are provided", async () => {
    const secret: CompanySecret = {
      id: "sec-1",
      companyId: "c1",
      scope: "company",
      ownerUserId: null,
      userSecretDefinitionId: null,
      key: "api_key",
      name: "API key",
      provider: "local_encrypted",
      status: "active",
      managedMode: "paperclip_managed",
      externalRef: null,
      providerConfigId: null,
      providerMetadata: null,
      latestVersion: 2,
      description: null,
      lastResolvedAt: null,
      lastRotatedAt: null,
      deletedAt: null,
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const value: Record<string, EnvBinding> = {
      API_KEY: { type: "secret_ref", secretId: "sec-1", version: "latest" },
    };
    await render({ value, secrets: [secret] });

    const keyInput = container.querySelector<HTMLInputElement>('input[placeholder="KEY"]');
    expect(keyInput?.value).toBe("API_KEY");
    expect(container.textContent).toContain("API key");
  });
});
